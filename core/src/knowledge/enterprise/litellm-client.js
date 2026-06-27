/**
 * HIVE-MIND - Enterprise LiteLLM Chat Completions Client
 *
 * OpenAI-compatible chat completions client for document type detection
 * and schema extraction via LiteLLM proxy.
 *
 * @module src/knowledge/enterprise/litellm-client
 */

import fetch from 'node-fetch';
import { meterTokens } from '../../billing/usage-tracker.js';
import { currentOrg, currentApiKey } from '../../db/prisma.js';

// Default routes through Groq direct (gpt-oss-20b — fast, cheap, JSON-mode).
// LITELLM_BASE_URL still wins when explicitly set (preserves backward compat).
// Routing logic:
// - If GROQ_API_KEY + model looks like a Groq model (openai/*, meta-llama/*,
//   llama-*, mixtral-*), route DIRECT to Groq even when LITELLM_BASE_URL is set.
// - Else fall back to LiteLLM proxy (or OpenAI-compatible base URL).
// This lets us mix LiteLLM (gemini/etc) + Groq (gpt-oss-20b) on the same box.
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const FORCE_GROQ_FOR_MODELS = /^(openai\/gpt-oss|meta-llama\/|llama-|mixtral-|gemma|qwen)/i;

const DEFAULT_MODEL = process.env.ENTERPRISE_EXTRACTION_MODEL
  || (GROQ_KEY ? 'openai/gpt-oss-20b' : 'gemini-2.5-flash-lite');
const LITELLM_API_KEY = process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || '';
const LITELLM_BASE_URL = (process.env.LITELLM_BASE_URL
  || process.env.OPENAI_API_BASE_URL
  || 'https://api.blaiq.ai/v1').replace(/\/+$/, '');
const GROQ_BASE_URL = 'https://api.groq.com/openai/v1';
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
// LLM_PRIMARY=openrouter forces all extract/cognition LLM calls onto OpenRouter (used when the Groq
// account is unavailable). Groq model ids are remapped to their OpenRouter equivalents.
const LLM_PRIMARY = (process.env.LLM_PRIMARY || '').toLowerCase();
const OPENROUTER_MODEL_MAP = {
  'llama-3.3-70b-versatile': 'meta-llama/llama-3.3-70b-instruct',
  'llama-3.1-8b-instant': 'meta-llama/llama-3.1-8b-instruct',
  'llama-3.1-70b-versatile': 'meta-llama/llama-3.1-70b-instruct',
  'openai/gpt-oss-20b': 'openai/gpt-oss-20b',
  'openai/gpt-oss-120b': 'openai/gpt-oss-120b',
};
function mapModelForOpenRouter(model) {
  if (OPENROUTER_MODEL_MAP[model]) return OPENROUTER_MODEL_MAP[model];
  // Groq uses -versatile/-instant suffixes; OpenRouter uses -instruct. Normalize, else leave as-is.
  if (/^llama-/i.test(model)) return `meta-llama/${model.replace(/-(versatile|instant)$/i, '-instruct')}`;
  return model;
}

function pickRoute(model) {
  if (LLM_PRIMARY === 'openrouter' && OPENROUTER_KEY) {
    return { base: OPENROUTER_BASE_URL, key: OPENROUTER_KEY, provider: 'openrouter' };
  }
  if (GROQ_KEY && FORCE_GROQ_FOR_MODELS.test(model || '')) {
    return { base: GROQ_BASE_URL, key: GROQ_KEY, provider: 'groq' };
  }
  return { base: LITELLM_BASE_URL, key: LITELLM_API_KEY, provider: 'litellm' };
}
const TIMEOUT_MS = 60_000;

/**
 * Send a chat completion request to the LiteLLM proxy.
 *
 * @param {Object} opts
 * @param {Array<{role: string, content: string}>} opts.messages - Chat messages
 * @param {string} [opts.model] - Override the default model
 * @param {number} [opts.temperature=0.1] - Sampling temperature
 * @param {number} [opts.max_tokens=4096] - Max tokens to generate
 * @param {boolean} [opts.json_mode=false] - Request JSON output
 * @returns {Promise<string|Object>} Parsed JSON object if json_mode, otherwise raw content string
 */
export async function chatCompletion({ messages, model, temperature = 0.1, max_tokens = 4096, json_mode = false, feature = 'enterprise-extract' }) {
  model = model || DEFAULT_MODEL;

  // Org-context gate: every LLM call should be attributable to an org (and, on the request path, its
  // HIVEMIND API key). Legitimate system/boot calls run with NO org context, so the default is to LOG,
  // not reject — a hard reject would break cognition/dreaming/boot. Set STRICT_ORG_METERING=true to
  // reject org-less calls (use only on request-scoped deployments where every call must carry an org).
  const _gateOrg = currentOrg();
  if (!_gateOrg) {
    if (String(process.env.STRICT_ORG_METERING || '').toLowerCase() === 'true') {
      throw new Error(`[enterprise-extract] LLM call rejected: no org context (STRICT_ORG_METERING, model=${model}, feature=${feature})`);
    }
    console.warn(`[enterprise-extract] LLM call with no org context — unattributed (model=${model} feature=${feature})`);
  }

  const body = {
    model,
    messages,
    temperature,
    max_tokens,
  };

  const route = pickRoute(model);
  // On OpenRouter, remap Groq model ids to their OpenRouter equivalents.
  if (route.provider === 'openrouter') body.model = mapModelForOpenRouter(model);
  // Groq's strict json_object mode rejects empty/invalid generations with
  // a 400. Skip strict mode there and rely on the salvage parser below.
  if (json_mode && route.provider !== 'groq') {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${route.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(route.key ? { Authorization: `Bearer ${route.key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`[enterprise-extract] Request timed out after ${TIMEOUT_MS}ms (model=${model})`);
    }
    throw new Error(`[enterprise-extract] Network error: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`[enterprise-extract] LiteLLM chat error ${res.status}: ${text}`);
  }

  const json = await res.json();
  const usage = json.usage;
  // gpt-oss-* reasoning models put visible output in reasoning_content (Groq)
  // or content; coalesce both.
  const msg = json.choices?.[0]?.message || {};
  const content = msg.content || msg.reasoning_content || '';

  console.log(`[enterprise-extract] provider=${route.provider} model=${model} tokens=${usage?.total_tokens}`);
  // METER AT THE GATEWAY — every org-context LLM call (cognition, dreamer, synthesizer, KB distill,
  // recall expansion, …) routes through here, so this single meter captures the platform's background
  // token spend that per-endpoint metering misses. orgId from AsyncLocalStorage (callers run inside
  // runWithOrg); no-op when there's no org context (system/boot calls). meterTokens is best-effort.
  try {
    meterTokens(currentOrg(), Number(usage?.total_tokens || 0), currentApiKey(), model, feature, {
      promptTokens: Number(usage?.prompt_tokens || 0),
      completionTokens: Number(usage?.completion_tokens || 0),
    });
  } catch { /* never let metering break a completion */ }

  if (json_mode) {
    // Robust parse: try direct, then strip code fences, then salvage first {...}/[...]
    const tryParse = (s) => {
      try { return JSON.parse(s); } catch { return null; }
    };
    let parsed = tryParse(content);
    if (parsed === null) {
      // Strip ```json ... ``` fences if present
      const fenced = content.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
      parsed = tryParse(fenced);
    }
    if (parsed === null) {
      // Salvage first balanced object/array
      const m = content.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
      if (m) parsed = tryParse(m[0]);
    }
    if (parsed !== null) return parsed;
    throw new Error(`[enterprise-extract] Failed to parse JSON response: ${content.slice(0, 200)}`);
  }

  return content;
}

/**
 * Returns the current default extraction model name.
 * @returns {string}
 */
export function getDefaultModel() {
  return DEFAULT_MODEL;
}

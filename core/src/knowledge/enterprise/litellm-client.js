/**
 * HIVE-MIND - Enterprise LiteLLM Chat Completions Client
 *
 * OpenAI-compatible chat completions client for document type detection
 * and schema extraction via LiteLLM proxy.
 *
 * @module src/knowledge/enterprise/litellm-client
 */

import fetch from 'node-fetch';
import { cloudflareGatewayEnabled, gatewayFirstFetch } from '../../llm/cloudflare-gateway.js';
import { meterTokens } from '../../billing/usage-tracker.js';
import { currentOrg, currentApiKey } from '../../db/prisma.js';
import { recordAiUsage, resolveAiModelPolicy } from '../../llm/ai-governance.js';

// Recover every COMPLETE top-level JSON object from a (possibly truncated)
// array-bearing string. Brace-counted and string/escape aware so braces or
// brackets inside string values never miscount. Used to salvage facts from a
// finish=length truncated LLM response — the objects that fully serialized
// before the cut are still valid and must not be discarded.
export function _salvageArrayObjects(text = '') {
  const s = String(text);
  // Start scanning at the first '[' (the array whose elements we want). The
  // fact objects sit INSIDE the outer {"facts":[…]} wrapper, so we count braces
  // relative to the array: an element object opens when depth 0→1 and completes
  // when it returns to 0 (nested objects inside it go 1→2→1 and don't miscount).
  const arrStart = s.indexOf('[');
  if (arrStart < 0) return [];
  const out = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = arrStart + 1; i < s.length; i += 1) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; continue; }
    if (c === '{') { if (depth === 0) start = i; depth += 1; }
    else if (c === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start >= 0) {
        try { out.push(JSON.parse(s.slice(start, i + 1))); } catch { /* skip malformed */ }
        start = -1;
      }
    }
  }
  return out;
}

export function shouldSalvageTruncatedJson(finishReason) {
  return finishReason === 'length';
}

export class TruncatedJsonCompletionError extends Error {
  constructor(message, partial = null) {
    super(message);
    this.name = 'TruncatedJsonCompletionError';
    this.code = 'LLM_JSON_TRUNCATED';
    this.partial = partial;
  }
}

function completionItemCount(value) {
  if (Array.isArray(value)) return value.length;
  if (Array.isArray(value?.facts)) return value.facts.length;
  return 0;
}

export function truncatedCompletionHasMoreItems(truncated, completed) {
  return completionItemCount(truncated?.partial) > completionItemCount(completed);
}

/**
 * Parse a JSON-mode completion while preserving the provider's finish contract.
 * A syntactically salvageable prefix is useful as a last-resort recovery asset,
 * but it is not a complete extraction when the provider says finish=length.
 */
export function parseJsonCompletion(content, finishReason, { rejectTruncated = false } = {}) {
  const tryParse = (s) => {
    try { return JSON.parse(s); } catch { return null; }
  };
  let parsed = tryParse(content);
  if (parsed === null && shouldSalvageTruncatedJson(finishReason)) {
    const fenced = String(content).replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
    parsed = tryParse(fenced);
  }
  if (parsed === null) {
    const m = String(content).match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (m) parsed = tryParse(m[0]);
  }
  if (parsed === null && shouldSalvageTruncatedJson(finishReason)) {
    const salvaged = _salvageArrayObjects(content);
    if (salvaged.length) parsed = /"facts"\s*:/.test(content) ? { facts: salvaged } : salvaged;
  }
  if (parsed !== null) {
    if (rejectTruncated && shouldSalvageTruncatedJson(finishReason)) {
      throw new TruncatedJsonCompletionError(
        `[enterprise-extract] JSON output truncated after ${completionItemCount(parsed)} complete item(s)`,
        parsed,
      );
    }
    if (shouldSalvageTruncatedJson(finishReason)) {
      console.warn(`[enterprise-extract] truncation-salvaged ${completionItemCount(parsed)} objects (finish=length)`);
    }
    return parsed;
  }
  throw new Error(`[enterprise-extract] Failed to parse JSON response (finish=${finishReason || 'unknown'}): ${String(content).slice(0, 200)}`);
}

// Default routes through Groq direct (gpt-oss-20b — fast, cheap, JSON-mode).
// LITELLM_BASE_URL still wins when explicitly set (preserves backward compat).
// Routing logic:
// - If GROQ_API_KEY + model looks like a Groq model (openai/*, meta-llama/*,
//   llama-*, mixtral-*), route DIRECT to Groq even when LITELLM_BASE_URL is set.
// - Else fall back to LiteLLM proxy (or OpenAI-compatible base URL).
// This lets us mix LiteLLM (gemini/etc) + Groq (gpt-oss-20b) on the same box.
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const FORCE_GROQ_FOR_MODELS = /^(openai\/gpt-oss|meta-llama\/|llama-|mixtral-|gemma|qwen)/i;

// Which OpenRouter BACKEND serves a given model family. Left unpinned, OpenRouter
// spreads Gemini across Vertex / Vertex-EU / AI Studio by its own weighting, and the
// three are NOT priced the same — measured 2026-08-03 for gemini-2.5-flash-lite:
//   Vertex     $0.087 in / $0.398 out   (49.3% of traffic)
//   Vertex-EU  $0.080 in / $0.398 out   (42.0%)
//   AI Studio  $0.074 in / $0.374 out   ( 8.7%)  <- cheapest on BOTH
// So 91% of our extraction traffic was landing on the dearer backends for no gain.
// One ordered table instead of a chain of per-family `if`s: first match wins, env
// overrides per family, and allow_fallbacks stays TRUE everywhere so a backend 429
// or outage degrades to slower/dearer rather than failing the ingest.
// NOTE for EU data residency: pinning AI Studio moves these calls off Vertex-EU. If a
// tenant needs in-EU inference, set OPENROUTER_GEMINI_PROVIDER_ORDER=google-vertex-eu.
const PROVIDER_PREFERENCE = [
  { test: FORCE_GROQ_FOR_MODELS, env: 'OPENROUTER_PROVIDER_ORDER', order: 'Groq' },
  { test: /gemini/i, env: 'OPENROUTER_GEMINI_PROVIDER_ORDER', order: 'google-ai-studio' },
];

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

// Logical model id for the Cloudflare custom provider. It intentionally is
// not an OpenRouter id: the origin token remains in Gateway configuration.
export function isQwenIngestModel(model) {
  return String(model || '').trim() === (process.env.QWEN_INGEST_MODEL || 'singulance/qwen3-ingest');
}

function pickRoute(model) {
  if (isQwenIngestModel(model)) {
    if (!cloudflareGatewayEnabled()) {
      throw new Error('[enterprise-extract] qwen ingestion requires enabled Cloudflare AI Gateway');
    }
    return {
      base: (process.env.QWEN_INGEST_BASE_URL || 'https://synthesize.singulancelabs.com/v1').replace(/\/+$/, ''),
      key: '', provider: 'qwen-ingest', wireModel: process.env.QWEN_INGEST_WIRE_MODEL || 'qwen3-ingest',
    };
  }
  if (LLM_PRIMARY === 'openrouter' && OPENROUTER_KEY) {
    return { base: OPENROUTER_BASE_URL, key: OPENROUTER_KEY, provider: 'openrouter' };
  }
  if (GROQ_KEY && FORCE_GROQ_FOR_MODELS.test(model || '')) {
    return { base: GROQ_BASE_URL, key: GROQ_KEY, provider: 'groq' };
  }
  return { base: LITELLM_BASE_URL, key: LITELLM_API_KEY, provider: 'litellm' };
}
const TIMEOUT_MS = 60_000;
// Learned provider capability, scoped to this process. If a provider says a
// model requires reasoning, do not pay for the same guaranteed 400 on every
// extraction window. This remains provider-driven rather than a model allowlist.
const reasoningDisableRejected = new Set();

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
export async function chatCompletion({ messages, model, temperature = 0.1, max_tokens = 4096, json_mode = false, response_format = null, reject_truncated_json = false, feature = 'enterprise-extract', respectModelPolicy = true }) {
  model = model || DEFAULT_MODEL;
  const useCase = /entity|relationship/i.test(feature) ? 'entity_linking' : 'ingestion_extraction';
  if (respectModelPolicy) {
    const modelPolicy = await resolveAiModelPolicy(useCase, model);
    model = modelPolicy.primary;
  }

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
  if (route.wireModel) body.model = route.wireModel;
  // On OpenRouter, remap Groq model ids to their OpenRouter equivalents.
  if (route.provider === 'openrouter') {
    body.model = mapModelForOpenRouter(model);
    // "use groq models from openrouter": for Groq-served models (gpt-oss,
    // llama, mixtral, gemma, qwen) PREFER the Groq backend — benchmarked ~4s
    // vs ~16s on other OpenRouter providers, valid JSON, 8/8 facts-with-entities.
    // allow_fallbacks stays TRUE so a Groq 429/outage falls back (slower) rather
    // than failing — robustness over raw speed. Gemini pins to the cheapest
    // backend; see PROVIDER_PREFERENCE for the measured prices behind the order.
    const _pref = PROVIDER_PREFERENCE.find((p) => p.test.test(model || ''));
    if (_pref) {
      const order = (process.env[_pref.env] || _pref.order).split(',').map((x) => x.trim()).filter(Boolean);
      if (order.length) {
        body.provider = { order, allow_fallbacks: process.env.OPENROUTER_ALLOW_FALLBACKS !== 'false' };
      }
    }
  }
  // Groq's strict json_object mode rejects empty/invalid generations with
  // a 400. Skip strict mode there and rely on the salvage parser below.
  if (response_format) {
    body.response_format = response_format;
  } else if (json_mode && route.provider !== 'groq') {
    body.response_format = { type: 'json_object' };
  }

  // REASONING OFF FOR STRUCTURED EXTRACTION. Benchmarked 2026-08-05 against the real
  // kb-unified-extract prompt on a real 2445-char German evidence window, one call per model:
  //
  //   model                      default            reasoning:{enabled:false}
  //   deepseek-v4-flash-0731     finish=length, 0 facts   ->  valid JSON, 7 facts, 1648 out_tok
  //   qwen3.7-flash              finish=length, 0 facts   ->  valid JSON, 8 facts, 1543 out_tok
  //   tencent/hy3-preview        finish=length, 0 facts   ->  valid JSON, 7 facts, 1342 out_tok
  //
  // Every reasoning model BLEW the token cap thinking and returned truncated, unparseable JSON —
  // the same silent-fallback-storm failure the gpt-oss-20b swap caused. With reasoning disabled they
  // emit ~1300-1600 output tokens and parse cleanly. This is the fix for the cap, not a bigger cap:
  // gemini finishes the identical task in 1262 tokens, so a budget that fits the WORK is being
  // consumed by deliberation we do not want here — extraction is transcription, not reasoning.
  //
  // NOTE `reasoning: { effort: 'minimal' }` does NOT disable it — measured 5362 and 5150 reasoning
  // tokens on deepseek and qwen respectively. Only `enabled: false` zeroes it.
  // Providers that MANDATE reasoning reject the field (gpt-oss-120b on google-vertex returns
  // HTTP 400 "Reasoning is mandatory for this endpoint"), so this is opt-out via env.
  if (route.provider === 'openrouter'
      && process.env.LLM_DISABLE_REASONING !== 'false'
      && !reasoningDisableRejected.has(model)) {
    body.reasoning = { enabled: false };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await gatewayFirstFetch(`${route.base}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(route.key ? { Authorization: `Bearer ${route.key}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    }, { fetchImpl: fetch });
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
    // SOME PROVIDERS MANDATE REASONING. We send `reasoning: {enabled:false}` on the openrouter path
    // because every reasoning model otherwise blows the token budget deliberating and returns
    // truncated, unparseable JSON. But gpt-oss-120b on google-vertex REJECTS the field outright:
    //   HTTP 400 "Reasoning is mandatory for this endpoint and cannot be disabled."
    // That model is COGNITION_WRITER_MODEL, HYPER_SYNTH_MODEL and a member of
    // KB_UNIFIED_FALLBACK_MODELS, so a blanket flag broke three live paths at once — caught by
    // calling all three configured models through this client after deploy, not by reading the diff.
    // Retry ONCE without the field rather than maintaining a hardcoded allow-list of models that
    // support it: the provider tells us, and that answer stays correct as providers change.
    if (res.status === 400 && body.reasoning && /reasoning/i.test(text)) {
      reasoningDisableRejected.add(model);
      console.warn(`[enterprise-extract] ${model} rejects reasoning:{enabled:false} — retrying without it`);
      const { reasoning: _dropped, ...bodyNoReasoning } = body;
      const ctrl2 = new AbortController();
      const timer2 = setTimeout(() => ctrl2.abort(), TIMEOUT_MS);
      try {
        // Same target and headers as the original call — they are built inline above, so they are
        // repeated here rather than referenced. (`url`/`headers` do not exist as variables; assuming
        // they did would have been a runtime ReferenceError that `node --check` cannot see.)
        const res2 = await gatewayFirstFetch(`${route.base}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(route.key ? { Authorization: `Bearer ${route.key}` } : {}),
          },
          body: JSON.stringify(bodyNoReasoning),
          signal: ctrl2.signal,
        }, { fetchImpl: fetch });
        if (res2.ok) { res = res2; } else {
          const t2 = await res2.text();
          throw new Error(`[enterprise-extract] LiteLLM chat error ${res2.status} (after reasoning retry): ${t2}`);
        }
      } finally {
        clearTimeout(timer2);
      }
    } else {
      throw new Error(`[enterprise-extract] LiteLLM chat error ${res.status}: ${text}`);
    }
  }

  const json = await res.json();
  const usage = json.usage;
  // gpt-oss-* reasoning models put visible output in reasoning_content (Groq)
  // or content; coalesce both.
  const msg = json.choices?.[0]?.message || {};
  const content = msg.content || msg.reasoning_content || '';

  console.log(`[enterprise-extract] provider=${route.provider} model=${model} tokens=${usage?.total_tokens} completion=${usage?.completion_tokens} finish=${json.choices?.[0]?.finish_reason || 'unknown'}`);
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
  void recordAiUsage({ usage, requestedModel: model, servedModel: json.model || model, provider: json.provider || route.provider, useCase });

  if (json_mode) {
    return parseJsonCompletion(content, json.choices?.[0]?.finish_reason, {
      rejectTruncated: reject_truncated_json,
    });
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

/**
 * Materialize a model chain once before issuing any request. This is deliberately
 * pure so model-governance behavior can be tested without a provider or database.
 */
export function buildModelFallbackChain({ requested = [], policy = null } = {}) {
  const requestedModels = Array.isArray(requested) ? requested.filter(Boolean) : [];
  const policyModels = policy?.source === 'admin'
    ? [policy.primary, policy.secondary].filter(Boolean)
    : [];
  return [...new Set([...policyModels, ...requestedModels])];
}

// Model-fallback wrapper: try each model in order; on ANY failure (provider
// error, timeout, finish=error, unparseable-after-salvage) fall through to the
// NEXT model. Cross-family list (e.g. gpt-oss-120b → gemini-flash-lite →
// gpt-oss-20b) so a single-model/provider issue can't drop a memory. Returns
// the first success; throws the last error only if every model fails.
export async function chatCompletionWithFallback({
  models = [], model, prefer_truncated_if_more_items = false, ...opts
} = {}) {
  const requested = (models.length ? models : [model]).filter(Boolean);
  const useCase = /entity|relationship/i.test(opts.feature || '') ? 'entity_linking' : 'ingestion_extraction';
  const policy = await resolveAiModelPolicy(useCase, requested[0] || null);
  // A policy-selected primary must have a policy-selected secondary. Previously
  // every fallback call re-entered chatCompletion() and was rewritten back to
  // the same admin primary, so an outage retried it N times instead of failing
  // over. Build the chain once, then make each attempt explicit.
  const list = buildModelFallbackChain({ requested, policy });
  if (!list.length) throw new Error('[llm-fallback] no model(s) provided');
  let lastErr = null;
  let bestTruncated = null;
  for (let i = 0; i < list.length; i += 1) {
    try {
      // A caller may supply the strict Qwen schema for a stable persistence
      // envelope. Do not impose that provider-specific schema on a fallback
      // family; normal json_mode remains enforced there.
      const { response_format, ...withoutSchema } = opts;
      const completed = await chatCompletion({
        ...(isQwenIngestModel(list[i]) ? opts : withoutSchema),
        model: list[i], respectModelPolicy: false,
      });
      // A provider-confirmed truncated prefix can hold far more grounded items
      // than a later model's syntactically complete but nearly empty response.
      // Dense extraction opts into rejecting that thin completion so its
      // bounded structural recovery can split the source window. Other JSON
      // callers retain first-success fallback behavior.
      if (prefer_truncated_if_more_items && bestTruncated
          && truncatedCompletionHasMoreItems(bestTruncated, completed)) {
        throw bestTruncated;
      }
      return completed;
    } catch (err) {
      lastErr = err;
      if (err?.code === 'LLM_JSON_TRUNCATED'
          && (!bestTruncated || completionItemCount(err.partial) > completionItemCount(bestTruncated.partial))) {
        bestTruncated = err;
      }
      const next = i + 1 < list.length ? `falling back to ${list[i + 1]}` : 'no more models';
      console.warn(`[llm-fallback] model ${list[i]} failed (${String(err.message).slice(0, 120)}) — ${next}`);
    }
  }
  if (bestTruncated) throw bestTruncated;
  throw lastErr;
}

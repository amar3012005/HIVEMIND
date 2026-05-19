/**
 * HIVE-MIND - Enterprise LiteLLM Chat Completions Client
 *
 * OpenAI-compatible chat completions client for document type detection
 * and schema extraction via LiteLLM proxy.
 *
 * @module src/knowledge/enterprise/litellm-client
 */

import fetch from 'node-fetch';

// Default routes through Groq direct (gpt-oss-20b — fast, cheap, JSON-mode).
// LITELLM_BASE_URL still wins when explicitly set (preserves backward compat).
const GROQ_KEY = process.env.GROQ_API_KEY || '';
const USE_GROQ = !process.env.LITELLM_BASE_URL && !process.env.OPENAI_API_BASE_URL && GROQ_KEY;

const DEFAULT_MODEL = process.env.ENTERPRISE_EXTRACTION_MODEL
  || (USE_GROQ ? 'openai/gpt-oss-20b' : 'gemini-2.5-flash-lite');
const API_KEY = USE_GROQ ? GROQ_KEY : (process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || '');
const BASE_URL = (process.env.LITELLM_BASE_URL
  || process.env.OPENAI_API_BASE_URL
  || (USE_GROQ ? 'https://api.groq.com/openai/v1' : 'https://api.blaiq.ai/v1')).replace(/\/+$/, '');
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
export async function chatCompletion({ messages, model, temperature = 0.1, max_tokens = 4096, json_mode = false }) {
  model = model || DEFAULT_MODEL;

  const body = {
    model,
    messages,
    temperature,
    max_tokens,
  };

  if (json_mode) {
    body.response_format = { type: 'json_object' };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { Authorization: `Bearer ${API_KEY}` } : {}),
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
  const content = json.choices?.[0]?.message?.content || '';

  console.log(`[enterprise-extract] model=${model} tokens=${usage?.total_tokens}`);

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

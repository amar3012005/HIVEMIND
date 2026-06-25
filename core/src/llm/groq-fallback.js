/**
 * HIVE-MIND — Groq → OpenRouter automatic failover for chat completions.
 *
 * Groq stays PRIMARY. On the healthy path there is ZERO added latency and ZERO
 * behavior change: `groqFetch` calls Groq direct first and, when Groq returns a
 * 2xx, that exact Response is returned untouched. OpenRouter is a pure additive
 * fallback — invoked ONLY when the Groq call throws (network / timeout / abort)
 * or returns a retryable status (408/409/425/429/5xx). On fallback the same
 * request is replayed against OpenRouter with the model id mapped to its
 * OpenRouter slug and provider preferences that keep latency + capability
 * (fastest provider that supports the request's params, with cross-provider
 * fallback inside OpenRouter).
 *
 * Scope: text-to-text /chat/completions ONLY. Embeddings, audio (whisper) and
 * vision requests pass straight through (no OpenRouter text equivalent), as do
 * Groq's agentic web-search "compound" models. Non-Groq URLs are a plain fetch.
 *
 * Adoption is a one-line change at any Groq call site: import `groqFetch` and
 * replace `fetch(` with `groqFetch(`. Because the healthy path returns the real
 * Groq Response, callers keep their own `.ok` / `.json()` / parse logic verbatim.
 *
 * @module src/llm/groq-fallback
 */
import nodeFetch, { Response as NodeResponse } from 'node-fetch';

// Prefer the runtime's global fetch/Response (undici on Node 20) so the healthy
// path returns the exact Response type a caller using global fetch expects;
// fall back to node-fetch only on older runtimes. This makes groqFetch a true
// drop-in for both global-fetch and node-fetch call sites.
const _fetch = (typeof globalThis !== 'undefined' && globalThis.fetch)
  ? globalThis.fetch.bind(globalThis)
  : nodeFetch;
const _Response = (typeof globalThis !== 'undefined' && globalThis.Response)
  ? globalThis.Response
  : NodeResponse;

const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const FALLBACK_TIMEOUT_MS = parseInt(process.env.OPENROUTER_FALLBACK_TIMEOUT_MS || '60000', 10);
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);

/**
 * Groq model id → OpenRouter slug.
 * `null` (or a model matched by NO_FALLBACK / an unknown bare id) means "no
 * OpenRouter text equivalent" → no fallback is attempted and the original Groq
 * failure is surfaced unchanged.
 */
const MODEL_MAP = {
  'openai/gpt-oss-120b': 'openai/gpt-oss-120b',
  'openai/gpt-oss-20b': 'openai/gpt-oss-20b',
  'gpt-oss-120b': 'openai/gpt-oss-120b',
  'gpt-oss-20b': 'openai/gpt-oss-20b',
  'llama-3.3-70b-versatile': 'meta-llama/llama-3.3-70b-instruct',
  'llama-3-3-70b-versatile': 'meta-llama/llama-3.3-70b-instruct',
  'llama-3.1-8b-instant': 'meta-llama/llama-3.1-8b-instruct',
  'llama-3.1-70b-versatile': 'meta-llama/llama-3.1-70b-instruct',
  'llama3-70b-8192': 'meta-llama/llama-3-70b-instruct',
  'llama3-8b-8192': 'meta-llama/llama-3-8b-instruct',
  'mixtral-8x7b-32768': 'mistralai/mixtral-8x7b-instruct',
  'gemma2-9b-it': 'google/gemma-2-9b-it',
  'meta-llama/llama-4-scout-17b-16e-instruct': 'meta-llama/llama-4-scout',
};

// Models with no OpenRouter text equivalent (agentic web-search / audio / vision
// / safety). These never fall back to OpenRouter.
const NO_FALLBACK = /compound|whisper|playai|tts|guard|vision|parakeet|moderation/i;

/**
 * Map a Groq model id to its OpenRouter slug, or null when no safe text
 * equivalent exists (→ caller keeps the Groq failure).
 * @param {string} model
 * @returns {string|null}
 */
export function mapModelToOpenRouter(model) {
  if (!model || typeof model !== 'string') return null;
  if (NO_FALLBACK.test(model)) return null;
  if (MODEL_MAP[model]) return MODEL_MAP[model];
  // Already-namespaced slugs (anthropic/*, google/*, deepseek/*, …) are valid
  // OpenRouter ids as-is.
  if (model.includes('/')) return model;
  // Unknown bare Groq id → do not risk a malformed fallback request.
  return null;
}

function isGroqChatUrl(url) {
  const s = String(url || '');
  return s.includes('api.groq.com') && s.includes('/chat/completions');
}

function logFallback(model, reason) {
  // warn (not log): a Groq outage is an operational signal worth surfacing.
  console.warn(`[groq-fallback] Groq failed (${reason}) → OpenRouter replay model=${model}`);
}

/**
 * Replay a parsed chat-completion request body against OpenRouter.
 * @param {Object} reqBody - the original OpenAI-shaped request body sent to Groq
 * @param {number} timeoutMs
 * @returns {Promise<Response|null>} an OpenRouter Response (JSON normalized to the
 *   Groq/OpenAI message shape), or null when no fallback is possible.
 */
async function openrouterReplay(reqBody, timeoutMs) {
  const orModel = mapModelToOpenRouter(reqBody && reqBody.model);
  if (!orModel || !OPENROUTER_KEY) return null;

  const body = { ...reqBody, model: orModel };
  // Fastest provider that still supports the request's params (tools /
  // response_format), with OpenRouter's own cross-provider fallback enabled.
  body.provider = { sort: 'throughput', allow_fallbacks: true, require_parameters: true };
  // `stream` cannot be honored by a buffered replay; never stream the fallback.
  if (body.stream) body.stream = false;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await _fetch(`${OPENROUTER_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'HTTP-Referer': 'https://hivemind.davinciai.eu',
        'X-Title': 'HIVEMIND',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) return res; // OpenRouter also failed → surface its response to the caller

  // Normalize: OpenRouter reasoning models expose `reasoning`; HIVEMIND readers
  // coalesce `content || reasoning_content`. Re-wrap so callers parse as usual.
  let json;
  try {
    json = await res.json();
  } catch {
    return res;
  }
  const msg = json && json.choices && json.choices[0] && json.choices[0].message;
  if (msg) {
    if (msg.reasoning && !msg.reasoning_content) msg.reasoning_content = msg.reasoning;
    if (!msg.content && (msg.reasoning_content || msg.reasoning)) {
      msg.content = msg.reasoning_content || msg.reasoning || '';
    }
  }
  return new _Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * Drop-in replacement for `fetch` at Groq chat-completion call sites.
 *
 * Identical to `fetch` for non-Groq URLs and for successful Groq calls (the
 * Groq Response is returned untouched). On a Groq failure (throw or retryable
 * status) the request is transparently replayed against OpenRouter and that
 * Response is returned instead.
 *
 * @param {string} url
 * @param {Object} [options] - standard fetch options (must include a JSON `body`)
 * @param {Object} [cfg]
 * @param {number} [cfg.timeoutMs] - OpenRouter replay timeout
 * @returns {Promise<Response>}
 */
export async function groqFetch(url, options = {}, cfg = {}) {
  if (!isGroqChatUrl(url)) {
    return _fetch(url, options);
  }
  const timeoutMs = cfg.timeoutMs || FALLBACK_TIMEOUT_MS;

  let reqBody = null;
  try {
    reqBody = options && options.body ? JSON.parse(options.body) : null;
  } catch {
    reqBody = null; // un-parseable body → cannot build a fallback; behave as plain fetch
  }

  // A streaming request cannot be faithfully replayed as a buffered fallback, so
  // streaming Groq calls are NOT failed-over: on failure the original Groq
  // response/throw is preserved (byte-identical to no-fallback behavior). This is
  // what makes groqFetch a perfect superset of fetch for every call shape.
  const isStreaming = !!(reqBody && reqBody.stream === true);

  try {
    const res = await _fetch(url, options);
    if (res.ok) return res; // healthy path — untouched
    if (!isStreaming && RETRYABLE_STATUS.has(res.status) && reqBody) {
      const fb = await openrouterReplay(reqBody, timeoutMs).catch(() => null);
      if (fb) {
        logFallback(reqBody.model, `status ${res.status}`);
        return fb;
      }
    }
    return res; // non-retryable, streaming, or no fallback available → original Groq response
  } catch (err) {
    if (!isStreaming && reqBody) {
      const fb = await openrouterReplay(reqBody, timeoutMs).catch(() => null);
      if (fb) {
        logFallback(reqBody.model, err && err.message ? err.message : 'network error');
        return fb;
      }
    }
    throw err; // streaming or no fallback possible → preserve original failure
  }
}

export default groqFetch;

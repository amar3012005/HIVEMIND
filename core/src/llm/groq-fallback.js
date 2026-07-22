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
import { readFileSync } from 'fs';
import { currentOrg, currentApiKey } from '../db/prisma.js';
import { meterTokens } from '../billing/usage-tracker.js';
import { chatCompletionFetch } from './chat-provider.js';

// Meter an LLM completion against the org's HIVEMIND API key. These helpers turn the already-routed
// Groq/OpenRouter funnel (groqFetch / memoryChatFetch — used by the memory pipeline + the server's
// global Groq monkeypatch) into a metering chokepoint, so background spend that never touches
// litellm-client's chatCompletion still records. Fire-and-forget: a metering failure never affects
// the completion. No-op when there's no org context (system/boot calls).
function _meterUsage(usage, model, feature) {
  try {
    const org = currentOrg();
    const total = Number(usage?.total_tokens || 0);
    if (!org || !(total > 0)) return;
    meterTokens(org, total, currentApiKey(), model, feature, {
      promptTokens: Number(usage?.prompt_tokens || 0),
      completionTokens: Number(usage?.completion_tokens || 0),
    });
  } catch { /* metering never breaks the call */ }
}
// Meter from a Response without disturbing the caller: clone() so the original body stays unread.
function _meterResponse(res, model, feature) {
  try {
    if (res && res.ok && typeof res.clone === 'function' && currentOrg()) {
      res.clone().json().then((j) => _meterUsage(j?.usage, model || j?.model, feature)).catch(() => {});
    }
  } catch { /* never throw into the caller path */ }
  return res;
}

// Prefer the runtime's global fetch/Response (undici on Node 20) so the healthy
// path returns the exact Response type a caller using global fetch expects;
// fall back to node-fetch only on older runtimes. This makes groqFetch a true
// drop-in for both global-fetch and node-fetch call sites.
const _fetch = (...args) => (
  typeof globalThis !== 'undefined' && globalThis.fetch
    ? globalThis.fetch(...args)
    : nodeFetch(...args)
);
const _Response = (typeof globalThis !== 'undefined' && globalThis.Response)
  ? globalThis.Response
  : NodeResponse;

const OPENROUTER_BASE = (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1').replace(/\/+$/, '');
const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY || '';
const FALLBACK_TIMEOUT_MS = parseInt(process.env.OPENROUTER_FALLBACK_TIMEOUT_MS || '60000', 10);
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504]);
// A Groq 400 is normally a malformed request (would also 400 on OpenRouter), so
// 400 is NOT retryable in general. EXCEPTION: account-level billing blocks (e.g.
// Groq "organization_delinquent" / overdue payment) come back as 400 but a
// different funded provider CAN serve the request — so these specifically do
// warrant failover.
const BILLING_BLOCK_RE = /organization_delinquent|overdue payment|payment method|account.*(suspend|restrict)|billing|insufficient.*(quota|credit)|quota.*exceeded/i;

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
  // Strip Groq-/OpenAI-specific params that OpenRouter's `require_parameters`
  // routing cannot satisfy for the target model — no provider advertises
  // support for them, so routing returns 404 "No endpoints found that can
  // handle the requested parameters". `parallel_tool_calls` is the proven
  // offender for gpt-oss-* + tools; `service_tier` is Groq-only and meaningless
  // to OpenRouter. Dropping them only relaxes a hint — tool-calling still works.
  delete body.parallel_tool_calls;
  delete body.service_tier;
  // OpenRouter uses `max_tokens`; `max_completion_tokens` (newer OpenAI/Groq
  // field) is not advertised by its providers → require_parameters routing
  // finds zero endpoints (404). Translate it so the cap is still honored.
  if (body.max_completion_tokens != null) {
    if (body.max_tokens == null) body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
  }
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

  // Canonical-provider delegation (rosemary Bug D): a caller asking for a
  // `cerebras/…` or `google/…` model is explicitly requesting the canonical
  // Cerebras/OpenRouter gateway — route it through chat-provider (Cerebras-first)
  // and NEVER Groq. This is inert for legacy model ids (which carry no such
  // prefix) until callsite defaults are migrated, so it adds zero behaviour
  // change to existing traffic. fetchImpl=_fetch: the cerebras/openrouter URLs
  // are not api.groq.com, so the global monkeypatch passes them straight through
  // (no recursion). RESILIENCE: chat-provider's cerebras route has no built-in
  // failover, but these callsites (situationalizer/entity-linker/cognition) run
  // on every ingest and previously had OpenRouter failover via this funnel — so
  // on a Cerebras error we replay to OpenRouter (gpt-oss on openai/*) rather than
  // let a Cerebras hiccup break ingestion.
  if (reqBody && typeof reqBody.model === 'string'
      && (reqBody.model.startsWith('cerebras/') || reqBody.model.startsWith('google/'))) {
    const _canonModel = reqBody.model;
    const _streaming = reqBody.stream === true;
    try {
      const r = await chatCompletionFetch(_canonModel, options, { fetchImpl: _fetch });
      if (r && r.ok) return r;
      if (!_streaming) {
        const fb = await openrouterReplay({ ...reqBody, model: _canonModel.replace(/^cerebras\//, 'openai/') }, timeoutMs).catch(() => null);
        if (fb) { logFallback(_canonModel, 'cerebras non-ok → openrouter'); return fb; }
      }
      return r;
    } catch (err) {
      if (!_streaming) {
        const fb = await openrouterReplay({ ...reqBody, model: _canonModel.replace(/^cerebras\//, 'openai/') }, timeoutMs).catch(() => null);
        if (fb) { logFallback(_canonModel, `cerebras error → openrouter (${err && err.message ? err.message : 'err'})`); return fb; }
      }
      throw err;
    }
  }

  // A streaming request cannot be faithfully replayed as a buffered fallback, so
  // streaming Groq calls are NOT failed-over: on failure the original Groq
  // response/throw is preserved (byte-identical to no-fallback behavior). This is
  // what makes groqFetch a perfect superset of fetch for every call shape.
  const isStreaming = !!(reqBody && reqBody.stream === true);

  // OpenRouter-primary mode (LLM_PRIMARY=openrouter): skip the Groq attempt entirely — used when the
  // Groq account is down/restricted. Go straight to OpenRouter; only if OpenRouter fails do we fall
  // through to Groq as a last resort. Streaming still goes direct to Groq (cannot be buffered-replayed).
  if (process.env.LLM_PRIMARY === 'openrouter' && !isStreaming && reqBody) {
    const fb = await openrouterReplay(reqBody, timeoutMs).catch(() => null);
    if (fb && fb.ok) { logFallback(reqBody.model, 'openrouter-primary'); return fb; }
  }

  try {
    const res = await _fetch(url, options);
    if (res.ok) return res; // healthy path — untouched (metering lives in memoryChatFetch / litellm / planEnforcer to avoid double-counting the monkeypatched TARA/chat sites)
    if (!isStreaming && reqBody) {
      if (RETRYABLE_STATUS.has(res.status)) {
        const fb = await openrouterReplay(reqBody, timeoutMs).catch(() => null);
        if (fb) {
          logFallback(reqBody.model, `status ${res.status}`);
          return fb;
        }
      } else if (res.status === 400) {
        // Inspect the body: fail over ONLY on a billing block (a funded provider
        // can serve it). Any other 400 is a real client error → reconstruct the
        // consumed response and return it unchanged so the caller behaves as before.
        const text = await res.text().catch(() => '');
        if (BILLING_BLOCK_RE.test(text)) {
          const fb = await openrouterReplay(reqBody, timeoutMs).catch(() => null);
          if (fb) {
            logFallback(reqBody.model, 'billing-block 400');
            return fb;
          }
        }
        return new _Response(text, {
          status: 400,
          headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
        });
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

/**
 * Canonical memory-creation LLM route. When MEMORY_LLM_PROVIDER=openrouter, the
 * distill / entity-extraction / entity-co-mention / memory-processor calls are
 * repointed to OpenRouter (model MEMORY_LLM_MODEL, default inception/mercury-2;
 * temperature MEMORY_LLM_TEMPERATURE) instead of a blocked/dead Groq account.
 * Returns null when the route is not active (→ keep the normal Groq path).
 * @returns {{url:string,key:string,model:string,temperature:number|undefined}|null}
 */
let _memFileCfg; // memoized JSON file fallback (read once)
function _memFileConfig() {
  if (_memFileCfg !== undefined) return _memFileCfg;
  _memFileCfg = null;
  const p = process.env.MEMORY_LLM_CONFIG_FILE || '/app/.memory-llm.json';
  try {
    _memFileCfg = JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    _memFileCfg = null; // no file → env-only
  }
  return _memFileCfg;
}

export function memoryLLMRoute() {
  // env is the intended knob; a JSON file (default /app/.memory-llm.json) is a
  // fallback for runtimes where new env can't be injected without a recreate.
  let provider = (process.env.MEMORY_LLM_PROVIDER || '').toLowerCase();
  let model = process.env.MEMORY_LLM_MODEL || '';
  let tRaw = process.env.MEMORY_LLM_TEMPERATURE;
  if (!provider) {
    const f = _memFileConfig();
    if (f) {
      provider = String(f.provider || '').toLowerCase();
      if (!model) model = f.model || '';
      if (tRaw === undefined) tRaw = f.temperature;
    }
  }
  if (provider !== 'openrouter' || !OPENROUTER_KEY) return null;
  const t = (tRaw !== undefined && tRaw !== '' && !Number.isNaN(parseFloat(tRaw))) ? parseFloat(tRaw) : undefined;
  return {
    url: `${OPENROUTER_BASE}/chat/completions`,
    key: OPENROUTER_KEY,
    model: model || 'inception/mercury-2',
    temperature: t,
  };
}

/**
 * Drop-in for fetch at the canonical memory-creation Groq call sites. When the
 * memory route is active (MEMORY_LLM_PROVIDER=openrouter) a Groq chat request is
 * rewritten to OpenRouter: model→MEMORY_LLM_MODEL, temperature→MEMORY_LLM_TEMPERATURE,
 * a strict json_schema response_format downgraded to json_object (portable across
 * providers; all callers have salvage parsers), provider prefs + OpenRouter auth.
 * When the route is NOT active it falls through to groqFetch (Groq primary +
 * OpenRouter failover) — so flipping the env is the only switch.
 *
 * @param {string} url
 * @param {Object} [options]
 * @param {Object} [cfg]
 * @returns {Promise<Response>}
 */
export async function memoryChatFetch(url, options = {}, cfg = {}) {
  const route = memoryLLMRoute();
  if (!route || !isGroqChatUrl(url)) {
    // Route inactive → Groq (+ OpenRouter failover) via groqFetch. Meter here so the memory-creation
    // pipeline — the sole caller of memoryChatFetch — records per-key spend that was previously invisible.
    const r = await groqFetch(url, options, cfg);
    let mdl = null; try { mdl = options?.body ? JSON.parse(options.body).model : null; } catch { /* ignore */ }
    return _meterResponse(r, mdl, 'memory-llm');
  }
  const timeoutMs = cfg.timeoutMs || FALLBACK_TIMEOUT_MS;
  let body = {};
  try {
    body = options && options.body ? JSON.parse(options.body) : {};
  } catch {
    body = {};
  }
  body.model = route.model;
  if (route.temperature !== undefined) body.temperature = route.temperature;
  if (body.stream) body.stream = false;
  // strict json_schema is gpt-oss-tuned; json_object is portable + every caller
  // already salvage-parses, so downgrade to keep other providers reliable.
  if (body.response_format && body.response_format.type === 'json_schema') {
    body.response_format = { type: 'json_object' };
  }
  if (!body.provider) {
    body.provider = { sort: 'throughput', allow_fallbacks: true, require_parameters: true };
  }
  const newOptions = {
    ...options,
    method: 'POST',
    headers: {
      ...(options.headers || {}),
      'Content-Type': 'application/json',
      Authorization: `Bearer ${route.key}`,
      'HTTP-Referer': 'https://hivemind.davinciai.eu',
      'X-Title': 'HIVEMIND',
    },
    body: JSON.stringify(body),
    signal: (options && options.signal) || AbortSignal.timeout(timeoutMs),
  };
  const res = await _fetch(route.url, newOptions);
  if (!res.ok) return res; // surface OpenRouter error to the caller's own handling
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
  _meterUsage(json?.usage, body.model, 'memory-llm');
  return new _Response(JSON.stringify(json), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export default groqFetch;

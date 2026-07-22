/**
 * HIVE-MIND — Canonical LLM chat-completion router (Cerebras → OpenRouter).
 *
 * Historically this file was a "Groq primary + OpenRouter failover" shim. Groq is
 * now retired for text: EVERY chat-completion is routed to the canonical providers
 * defined ONCE in `./llm-config.js` (Cerebras primary, OpenRouter failover), with
 * the canonical model (`gpt-oss-120b`) forced regardless of the legacy model id a
 * call site passes. The export name `groqFetch` is kept so the ~10 importers and
 * the global fetch wrap in server.js (which intercepts every `api.groq.com`
 * chat-completions call) need no change — they transparently become canonical.
 *
 * NON-text Groq endpoints (whisper/STT, vision, agentic "compound" web-search,
 * tts, guard/moderation, parakeet) have no gpt-oss equivalent and are passed
 * through UNCHANGED to their original URL — this router only canonicalizes text
 * chat completions.
 *
 * gpt-oss is a reasoning model; a low reasoning effort is set by default (see
 * llm-config) so short classification/judge calls still return content instead of
 * spending their whole token budget on reasoning, and latency stays low.
 *
 * @module src/llm/groq-fallback
 */
import nodeFetch, { Response as NodeResponse } from 'node-fetch';
import { currentOrg, currentApiKey } from '../db/prisma.js';
import { meterTokens } from '../billing/usage-tracker.js';
import { activeProviders, CANONICAL_MODEL, REASONING_EFFORT } from './llm-config.js';

// ── Metering (unchanged): turn the funnel into a per-key spend chokepoint. ──
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
function _meterResponse(res, model, feature) {
  try {
    if (res && res.ok && typeof res.clone === 'function' && currentOrg()) {
      res.clone().json().then((j) => _meterUsage(j?.usage, model || j?.model, feature)).catch(() => {});
    }
  } catch { /* never throw into the caller path */ }
  return res;
}

// Prefer the runtime's global fetch/Response (undici on Node 20); fall back to
// node-fetch on older runtimes. Keeps groqFetch a true drop-in for both call styles.
const _fetch = (...args) => (
  typeof globalThis !== 'undefined' && globalThis.fetch ? globalThis.fetch(...args) : nodeFetch(...args)
);
const _Response = (typeof globalThis !== 'undefined' && globalThis.Response) ? globalThis.Response : NodeResponse;

const FALLBACK_TIMEOUT_MS = parseInt(process.env.OPENROUTER_FALLBACK_TIMEOUT_MS || '60000', 10);

// Non-text models: no gpt-oss equivalent → never canonicalized, passed through.
const NO_FALLBACK = /compound|whisper|playai|tts|guard|vision|parakeet|moderation|embed/i;

function isChatCompletionsUrl(url) {
  return String(url || '').includes('/chat/completions');
}

/**
 * Legacy shim kept for import compatibility. The canonical router no longer needs
 * a Groq→OpenRouter slug map (llm-config owns the model), but a few modules still
 * import this to normalize a model id. Returns the id namespaced for OpenRouter.
 */
export function mapModelToOpenRouter(model) {
  if (!model || typeof model !== 'string') return null;
  if (NO_FALLBACK.test(model)) return null;
  return model.includes('/') ? model : `openai/${model}`;
}

// Build the request body for a specific canonical provider: force the canonical
// model + reasoning effort, strip params no provider will accept, translate the
// token cap, and downgrade strict json_schema → portable json_object.
function buildProviderBody(provider, reqBody) {
  const body = { ...reqBody, model: provider.model };
  if (REASONING_EFFORT && body.reasoning_effort == null) body.reasoning_effort = REASONING_EFFORT;
  delete body.parallel_tool_calls; // OpenRouter require_parameters 404s on this for gpt-oss+tools
  delete body.service_tier;        // Groq-only, meaningless elsewhere
  if (body.max_completion_tokens != null) {
    if (body.max_tokens == null) body.max_tokens = body.max_completion_tokens;
    delete body.max_completion_tokens;
  }
  if (body.response_format && body.response_format.type === 'json_schema') {
    body.response_format = { type: 'json_object' }; // portable; every caller salvage-parses
  }
  if (provider.supportsProviderPrefs) {
    // Fastest provider inside OpenRouter that still supports the request's params.
    body.provider = { sort: 'throughput', allow_fallbacks: true, require_parameters: true };
  } else {
    delete body.provider; // Cerebras rejects OpenRouter's provider routing object
  }
  return body;
}

// Re-wrap a completed (non-streaming) provider response into the OpenAI/Groq shape
// callers expect: coalesce reasoning → content for reasoning models.
async function normalizeCompletion(res) {
  let json;
  try { json = await res.json(); } catch { return res; }
  const msg = json?.choices?.[0]?.message;
  if (msg) {
    if (msg.reasoning && !msg.reasoning_content) msg.reasoning_content = msg.reasoning;
    if (!msg.content && (msg.reasoning_content || msg.reasoning)) {
      msg.content = msg.reasoning_content || msg.reasoning || '';
    }
  }
  return { json, res: new _Response(JSON.stringify(json), { status: 200, headers: { 'content-type': 'application/json' } }) };
}

function logFailover(fromName, toName, model, reason) {
  console.warn(`[llm] ${fromName} failed (${reason}) → ${toName} replay model=${model}`);
}

async function callProvider(provider, body, baseOptions, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await _fetch(provider.url, {
      ...baseOptions,
      method: 'POST',
      headers: {
        ...(baseOptions.headers || {}),
        'Content-Type': 'application/json',
        Authorization: `Bearer ${provider.key}`,
        ...provider.headers,
      },
      body: JSON.stringify(body),
      signal: baseOptions.signal || controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Canonical chat-completion router. Drop-in for `fetch` at every historical Groq
 * call site. Non-chat URLs and non-text models pass through unchanged; text chat
 * completions are routed to the canonical providers (Cerebras → OpenRouter) with
 * the canonical model forced.
 */
export async function groqFetch(url, options = {}, cfg = {}) {
  if (!isChatCompletionsUrl(url)) return _fetch(url, options);

  let reqBody = null;
  try { reqBody = options?.body ? JSON.parse(options.body) : null; } catch { reqBody = null; }
  if (!reqBody) return _fetch(url, options); // can't canonicalize an opaque body

  // Non-text models (audio/vision/websearch/...) → leave on their original path.
  if (reqBody.model && NO_FALLBACK.test(reqBody.model)) return _fetch(url, options);

  const providers = activeProviders();
  if (!providers.length) return _fetch(url, options); // nothing configured → original path

  const timeoutMs = cfg.timeoutMs || FALLBACK_TIMEOUT_MS;
  const streaming = reqBody.stream === true;
  let lastRes = null;

  for (let i = 0; i < providers.length; i++) {
    const provider = providers[i];
    const body = buildProviderBody(provider, reqBody);
    if (streaming) body.stream = true;
    let res = null;
    try {
      res = await callProvider(provider, body, options, timeoutMs);
    } catch (err) {
      if (i + 1 < providers.length) { logFailover(provider.name, providers[i + 1].name, body.model, err?.message || 'network error'); continue; }
      throw err; // last provider threw → preserve the failure
    }
    if (res.ok) {
      if (i > 0) logFailover(providers[i - 1].name, provider.name, body.model, 'recovered');
      if (streaming) return res; // stream as-is; no mid-stream failover
      // NB: metering is intentionally NOT done here — it lives in memoryChatFetch /
      // litellm-client / planEnforcer so the monkeypatched TARA/chat sites are not
      // double-counted (same topology as before this canonical rewrite).
      const norm = await normalizeCompletion(res);
      return norm.res || res;
    }
    // non-ok: fail over to the next provider if any
    lastRes = res;
    if (i + 1 < providers.length) {
      logFailover(provider.name, providers[i + 1].name, body.model, `status ${res.status}`);
      continue;
    }
  }
  return lastRes; // all providers non-ok → surface the last response to the caller
}

/**
 * Memory-creation LLM route. Deprecated as an independent config: memory writes
 * now use the SAME canonical router as everything else (llm-config). Kept as a
 * thin metering delegate so the memory pipeline still records per-key spend.
 */
export function memoryLLMRoute() { return null; }

export async function memoryChatFetch(url, options = {}, cfg = {}) {
  const r = await groqFetch(url, options, { ...cfg, feature: cfg.feature || 'memory-llm' });
  let mdl = null; try { mdl = options?.body ? JSON.parse(options.body).model : null; } catch { /* ignore */ }
  return _meterResponse(r, mdl || CANONICAL_MODEL, 'memory-llm');
}

export default groqFetch;

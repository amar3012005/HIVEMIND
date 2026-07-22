/**
 * HIVE-MIND — Canonical LLM configuration. THE single source of truth.
 *
 * Every chat-completion in the system (chat, recall synthesis, ingestion,
 * classification, judges, TARA text) routes through the groq-fallback chokepoint,
 * which reads its provider order, API keys, base URLs, and model from HERE and
 * nowhere else. The ~30 historical call sites that hardcode `api.groq.com` + a
 * per-site model id are transparently re-pointed at this config by the global
 * fetch wrap in server.js — their model ids are overridden with the canonical
 * model, so there is exactly one place a key / endpoint / model is defined.
 *
 * Policy (owner decision 2026-07-22): providers are Cerebras (PRIMARY, lowest
 * latency) → OpenRouter (FAILOVER) ONLY. No Groq. Model is a single canonical
 * `gpt-oss-120b` (no llama). gpt-oss is a reasoning model, so a low reasoning
 * effort is set by default to keep short classification/judge calls returning
 * content (not spending the whole token budget on reasoning) and latency low.
 *
 * To change provider order, keys, or the model, change env HERE — not a call site:
 *   LLM_MODEL              canonical model (default gpt-oss-120b)
 *   LLM_REASONING_EFFORT   low | medium | high (default low)
 *   CEREBRAS_API_KEY       primary provider key
 *   CEREBRAS_BASE_URL      default https://api.cerebras.ai/v1
 *   OPENROUTER_API_KEY     failover provider key
 *   OPENROUTER_BASE_URL    default https://openrouter.ai/api/v1
 *   LLM_PROVIDER_ORDER     csv override of provider order (default "cerebras,openrouter")
 *
 * @module src/llm/llm-config
 */

const stripSlash = (s) => String(s || '').replace(/\/+$/, '');

export const CANONICAL_MODEL = process.env.LLM_MODEL || 'gpt-oss-120b';
export const REASONING_EFFORT = (process.env.LLM_REASONING_EFFORT || 'low').toLowerCase();

// Per-provider definition. `modelSlug(model)` maps the canonical bare model id to
// the slug that provider expects (OpenRouter namespaces gpt-oss under `openai/`).
const PROVIDER_DEFS = {
  cerebras: {
    name: 'cerebras',
    base: () => stripSlash(process.env.CEREBRAS_BASE_URL || 'https://api.cerebras.ai/v1'),
    key: () => process.env.CEREBRAS_API_KEY || '',
    // Cerebras uses the BARE id (gpt-oss-120b, qwen-3-*). A namespaced canonical
    // (e.g. LLM_MODEL=openai/gpt-oss-120b) 404s here, so strip any prefix.
    modelSlug: (m) => (m.includes('/') ? m.slice(m.lastIndexOf('/') + 1) : m),
    // Cerebras does NOT accept OpenRouter's `provider` routing object.
    supportsProviderPrefs: false,
  },
  openrouter: {
    name: 'openrouter',
    base: () => stripSlash(process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'),
    key: () => process.env.OPENROUTER_API_KEY || '',
    // OpenRouter namespaces the OpenAI open-weight models under `openai/`.
    modelSlug: (m) => (m.includes('/') ? m : `openai/${m}`),
    supportsProviderPrefs: true,
    headers: { 'HTTP-Referer': 'https://hivemind.davinciai.eu', 'X-Title': 'HIVEMIND' },
  },
};

function providerOrder() {
  const raw = (process.env.LLM_PROVIDER_ORDER || 'cerebras,openrouter')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return raw.length ? raw : ['cerebras', 'openrouter'];
}

/**
 * Ordered list of providers that actually have a key configured. First entry is
 * primary; the rest are failover targets, in order. Returns [] if nothing is set
 * (caller then leaves the request on its original path).
 */
export function activeProviders() {
  const out = [];
  for (const name of providerOrder()) {
    const def = PROVIDER_DEFS[name];
    if (!def) continue;
    const key = def.key();
    if (!key) continue;
    out.push({
      name: def.name,
      url: `${def.base()}/chat/completions`,
      key,
      model: def.modelSlug(CANONICAL_MODEL),
      supportsProviderPrefs: def.supportsProviderPrefs,
      headers: def.headers || {},
    });
  }
  return out;
}

/** True when at least one canonical provider is configured. */
export function hasCanonicalProvider() {
  return activeProviders().length > 0;
}

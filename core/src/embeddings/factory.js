/**
 * HIVE-MIND — Embedding service factory + primary/fallback wrapper.
 *
 * Step 2 of the bge-m3 1024 cutover. Builds an embed service from env and,
 * when a fallback provider is configured, wraps primary+fallback so a transient
 * primary failure (e.g. the prometheus GPU box behind an ephemeral tunnel is
 * down) transparently degrades to blaiq LiteLLM. Both run bge-m3 → 1024-dim
 * vectors are interchangeable.
 *
 * Env:
 *   EMBEDDING_PROVIDER            primary: 'litellm' (blaiq) | 'openrouter' | else mistral/custom (/embed)
 *   EMBEDDING_FALLBACK_PROVIDER   optional second link
 *   EMBEDDING_FALLBACK2_PROVIDER  optional third link (secondary fallback)
 *   EMBEDDING_TERMINAL_FALLBACK   'false' to suppress the guaranteed bge-m3 last resort
 *   EMBEDDING_LINK_COOLDOWN_MS    how long a failed link is deprioritised (default 60000)
 *   EMBEDDING_DIMENSION           vector dim (target 1024 for bge-m3)
 *   OPENROUTER_API_KEY            required for any 'openrouter' link, incl. the terminal one
 *   OPENROUTER_EMBED_MODEL        default 'baai/bge-m3'; OPENROUTER_BASE_URL default openrouter.ai/api/v1
 *
 * OpenRouter baai/bge-m3 (1024-dim, $0.01/M tokens) is appended as a TERMINAL link whenever a key
 * is present and the width is 1024, so an embedding call fails only if every provider is down.
 * A chain of one is returned bare, so a single-provider deployment is unchanged.
 *
 * @module src/embeddings/factory
 */

import { getMistralEmbedService, MistralEmbedService } from './mistral.js';
import { getLiteLLMEmbedService, LiteLLMEmbedService } from './litellm.js';

// How long a link that just failed is DEPRIORITISED for. It is never removed — see embed().
const LINK_COOLDOWN_MS = Number(process.env.EMBEDDING_LINK_COOLDOWN_MS || 60000);

/**
 * An ORDERED CHAIN of embed services. Tries each in turn and only fails when EVERY link fails.
 *
 * Replaces a two-link primary/fallback wrapper with three concrete corrections:
 *
 * 1. A DEAD PRIMARY USED TO COST THE FULL TIMEOUT ON EVERY CALL. `_primaryHealthy` was tracked
 *    but only ever used to decide whether to LOG — the primary was still awaited first every
 *    time. With EMBEDDING_TIMEOUT_MS=30000 (litellm.js:26, no retry of its own) one unreachable
 *    primary added 30s to every embedding call: measured 30616ms for a single recall on live
 *    while the fallback itself was healthy and answering. A stall that long is a failure whatever
 *    the status code says. A failed link is now deprioritised for LINK_COOLDOWN_MS.
 *
 * 2. COOLDOWN DEPRIORITISES, IT DOES NOT REMOVE. A cooled-down link moves to the BACK of the
 *    order, so if every healthy link fails it is still tried as a last resort. Skipping it
 *    outright would turn "slow" into "no embedding at all", which is the opposite of the goal.
 *
 * 3. ANY NUMBER OF LINKS. The chain only failed over once, so if the single fallback was also
 *    down the call threw. A secondary fallback is now just another entry.
 *
 * SAME DIMENSION IS NOT SAME VECTOR SPACE. Vectors are only interchangeable across links running
 * the SAME MODEL — bge-m3 on one host and bge-m3 on another are; bge-m3 and mistral-embed are
 * both 1024-dim and are NOT. Mixing spaces does not raise an error, it silently returns
 * nonsense neighbours, which is far worse than a failed embedding. buildChain() therefore warns
 * loudly on a dimension mismatch, and the model identity is a deployment responsibility.
 *
 * Conforms to the embed-service interface (embed / embedOne / getDimension / testConnection /
 * clearCache / getCacheStats).
 */
export class FallbackEmbedService {
  /** @param {Array<{name: string, service: object}>} links ordered, most-preferred first */
  constructor(links) {
    this.links = (links || []).filter((l) => l && l.service);
    this.provider = 'fallback';
    this._downUntil = new Map();
    if (!this.links.length) throw new Error('FallbackEmbedService: no embed links configured');
  }

  /** Healthy links first (declaration order preserved), cooled-down links last but still tried. */
  _order(now) {
    const hot = [];
    const cold = [];
    for (const l of this.links) ((this._downUntil.get(l.name) || 0) > now ? cold : hot).push(l);
    return [...hot, ...cold];
  }

  async embed(input, options = {}) {
    const errors = [];
    for (const link of this._order(Date.now())) {
      try {
        const out = await link.service.embed(input, options);
        if (this._downUntil.delete(link.name)) console.log(`✅ Embedding link '${link.name}' recovered`);
        if (errors.length) console.warn(`[embed] served by fallback '${link.name}' after ${errors.length} failure(s)`);
        return out;
      } catch (err) {
        // Log the FIRST failure of each link, not every one — a hot loop with a dead primary
        // would otherwise bury the log. The cooldown entry doubles as the "already reported" mark.
        if (!this._downUntil.has(link.name)) {
          console.error(`⚠️  Embedding link '${link.name}' failed: ${err.message}`);
        }
        this._downUntil.set(link.name, Date.now() + LINK_COOLDOWN_MS);
        errors.push(`${link.name}: ${err.message}`);
      }
    }
    // EVERY link failed. Throw — never return a zero vector or a partial result, which would be
    // indexed or searched as if it were real and is unrecoverable after the fact.
    throw new Error(`all ${this.links.length} embedding providers failed — ${errors.join(' | ')}`);
  }

  async embedOne(text, options = {}) {
    const [vec] = await this.embed(text, options);
    return vec;
  }

  getDimension() {
    for (const l of this.links) {
      const d = l.service.getDimension?.();
      if (d) return d;
    }
    return undefined;
  }

  clearCache() {
    for (const l of this.links) l.service.clearCache?.();
  }

  getCacheStats() {
    const now = Date.now();
    return {
      provider: 'fallback',
      links: this.links.map((l) => ({
        name: l.name,
        cooling_down: (this._downUntil.get(l.name) || 0) > now,
        stats: l.service.getCacheStats?.(),
      })),
    };
  }

  async testConnection() {
    for (const l of this.links) {
      // eslint-disable-next-line no-await-in-loop
      if (await (l.service.testConnection?.().catch(() => false) ?? false)) return true;
      console.warn(`⚠️  Embedding link '${l.name}' unreachable at boot — trying next`);
    }
    return false;
  }
}

// OpenRouter hosts bge-m3 (baai/bge-m3, 1024-dim) behind an OpenAI-compatible
// /embeddings endpoint, so the LiteLLM client works verbatim — just repointed at
// openrouter.ai with the OpenRouter key. Same 1024-dim contract → vectors are
// interchangeable with the self-hosted / blaiq bge-m3 primary. Intended as a
// managed FALLBACK (multi-provider uptime) when the primary box is unreachable.
function makeOpenRouterService() {
  return new LiteLLMEmbedService(
    process.env.OPENROUTER_EMBED_MODEL || 'baai/bge-m3',
    process.env.OPENROUTER_API_KEY || '',
    process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1',
    { timeoutMs: Number(process.env.OPENROUTER_EMBED_TIMEOUT_MS || 2000) },
  );
}

/**
 * @param {string} provider
 * @param {boolean} fresh build a NEW instance rather than the module singleton. Required for any
 *   non-primary link: a litellm primary plus a litellm-shaped fallback must not collapse into one
 *   object, or "failover" would retry the same dead endpoint.
 */
function buildService(provider, fresh = false) {
  if (provider === 'litellm') return fresh ? new LiteLLMEmbedService() : getLiteLLMEmbedService();
  if (provider === 'openrouter') return makeOpenRouterService();
  // 'mistral' / custom-endpoint / default
  if (!fresh) return getMistralEmbedService();
  return new MistralEmbedService(
    process.env.MISTRAL_API_KEY || process.env.EMBEDDING_API_KEY,
    process.env.MISTRAL_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL_NAME || 'mistral-embed',
    process.env.EMBEDDING_FALLBACK_URL || undefined
  );
}

/**
 * Build the ordered chain from env, de-duplicated, with a TERMINAL bge-m3 link.
 *
 * Order: EMBEDDING_PROVIDER, EMBEDDING_FALLBACK_PROVIDER, EMBEDDING_FALLBACK2_PROVIDER, then —
 * unless already present or explicitly disabled — OpenRouter baai/bge-m3 as the last resort.
 * OpenRouter is a managed multi-provider endpoint, so it is the sensible terminal link: it does
 * not share a failure domain with a self-hosted GPU box or a single vendor.
 *
 * The terminal link is only appended when OPENROUTER_API_KEY exists (a keyless link would fail on
 * every call and merely add latency to the error path) and when EMBEDDING_DIMENSION is 1024 —
 * bge-m3 emits 1024, and appending it to a chain of a different width would produce vectors that
 * cannot be stored or compared. Set EMBEDDING_TERMINAL_FALLBACK=false to opt out.
 */
function buildChain() {
  const wanted = [
    process.env.EMBEDDING_PROVIDER || 'mistral',
    process.env.EMBEDDING_FALLBACK_PROVIDER,
    process.env.EMBEDDING_FALLBACK2_PROVIDER,
  ].filter(Boolean);

  const dim = Number(process.env.EMBEDDING_DIMENSION || 1024);
  const terminalOk = process.env.EMBEDDING_TERMINAL_FALLBACK !== 'false'
    && !!process.env.OPENROUTER_API_KEY
    && dim === 1024;
  if (terminalOk && !wanted.includes('openrouter')) wanted.push('openrouter');
  else if (process.env.EMBEDDING_TERMINAL_FALLBACK !== 'false' && !wanted.includes('openrouter')) {
    // Say WHY the guaranteed last resort is absent, rather than silently running without one.
    console.warn('[embed] terminal bge-m3 fallback NOT added: '
      + `${!process.env.OPENROUTER_API_KEY ? 'OPENROUTER_API_KEY missing' : `EMBEDDING_DIMENSION=${dim} (bge-m3 is 1024)`}`);
  }

  const seen = new Set();
  const links = [];
  for (const name of wanted) {
    if (seen.has(name)) continue;      // primary===fallback would otherwise retry one dead box twice
    seen.add(name);
    try {
      links.push({ name, service: buildService(name, links.length > 0) });
    } catch (e) {
      console.error(`[embed] could not construct provider '${name}': ${e.message} — skipping`);
    }
  }

  // Same dimension is the only machine-checkable half of "interchangeable"; model identity is not
  // observable here. A mismatch means one link writes vectors the collection cannot hold.
  const dims = [...new Set(links.map((l) => l.service.getDimension?.()).filter(Boolean))];
  if (dims.length > 1) {
    console.error(`[embed] DIMENSION MISMATCH across the chain: ${JSON.stringify(dims)} — `
      + 'vectors from these links are NOT interchangeable and recall will silently degrade. '
      + 'Fix EMBEDDING_DIMENSION / provider models before relying on failover.');
  }
  console.log(`[embed] chain: ${links.map((l) => l.name).join(' -> ') || '(none)'} (dim=${dim})`);
  return links;
}

let _instance = null;

/**
 * Central embed-service accessor. Returns a singleton; primary chosen by
 * EMBEDDING_PROVIDER, wrapped with a fallback when EMBEDDING_FALLBACK_PROVIDER
 * is set (and differs from primary).
 * @returns {object} embed service
 */
export function getEmbedService() {
  if (_instance) return _instance;
  const links = buildChain();
  // A single link is returned BARE. Wrapping one provider in the chain would add a cooldown map
  // and a rewritten error message around a service that has nowhere to fail over to.
  _instance = links.length > 1 ? new FallbackEmbedService(links) : links[0].service;
  return _instance;
}

export default getEmbedService;

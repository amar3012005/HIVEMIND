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
 *   EMBEDDING_PROVIDER           primary: 'litellm' (blaiq) | 'openrouter' | else mistral/custom (/embed)
 *   EMBEDDING_FALLBACK_PROVIDER  optional: 'litellm' | 'openrouter' | 'mistral' — enables the wrapper
 *   EMBEDDING_DIMENSION          vector dim (target 1024 for bge-m3)
 *   OPENROUTER_API_KEY           required when (fallback)provider = 'openrouter'
 *   OPENROUTER_EMBED_MODEL       default 'baai/bge-m3'; OPENROUTER_BASE_URL default openrouter.ai/api/v1
 *
 * When EMBEDDING_FALLBACK_PROVIDER is unset, returns the bare primary — identical
 * behavior to the pre-step-2 selection, so this is safe to ship dark.
 *
 * @module src/embeddings/factory
 */

import { getMistralEmbedService, MistralEmbedService } from './mistral.js';
import { getLiteLLMEmbedService, LiteLLMEmbedService } from './litellm.js';

/**
 * Wraps a primary and fallback embed service. Tries primary; on any throw,
 * logs once and serves from fallback. Conforms to the embed-service interface
 * (embed / embedOne / getDimension / testConnection / clearCache / getCacheStats).
 */
export class FallbackEmbedService {
  constructor(primary, fallback) {
    this.primary = primary;
    this.fallback = fallback;
    this.provider = 'fallback';
    this._primaryHealthy = true;
  }

  async embed(input) {
    try {
      const out = await this.primary.embed(input);
      if (!this._primaryHealthy) {
        console.log('✅ Embedding primary recovered');
        this._primaryHealthy = true;
      }
      return out;
    } catch (err) {
      if (this._primaryHealthy) {
        console.error(`⚠️  Embedding primary failed, falling back: ${err.message}`);
        this._primaryHealthy = false;
      }
      return this.fallback.embed(input);
    }
  }

  async embedOne(text) {
    const [vec] = await this.embed(text);
    return vec;
  }

  getDimension() {
    return this.primary.getDimension?.() ?? this.fallback.getDimension?.();
  }

  clearCache() {
    this.primary.clearCache?.();
    this.fallback.clearCache?.();
  }

  getCacheStats() {
    return {
      provider: 'fallback',
      primary: this.primary.getCacheStats?.(),
      fallback: this.fallback.getCacheStats?.()
    };
  }

  async testConnection() {
    const p = await this.primary.testConnection?.().catch(() => false);
    if (p) return true;
    console.warn('⚠️  Embedding primary unreachable at boot — testing fallback');
    return this.fallback.testConnection?.().catch(() => false) ?? false;
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
    process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1'
  );
}

function buildService(provider) {
  if (provider === 'litellm') return getLiteLLMEmbedService();
  if (provider === 'openrouter') return makeOpenRouterService();
  // 'mistral' / custom-endpoint / default
  return getMistralEmbedService();
}

export function resolveEmbeddingProviders(env = process.env) {
  const explicitPrimary = env.EMBEDDING_PROVIDER?.trim();
  const primary = explicitPrimary || (
    env.LITELLM_API_KEY ? 'litellm'
      : env.OPENROUTER_API_KEY ? 'openrouter'
      : 'mistral'
  );
  const explicitFallback = env.EMBEDDING_FALLBACK_PROVIDER?.trim();

  return {
    primary,
    fallback: explicitFallback || (
      !explicitPrimary && primary === 'litellm' && env.OPENROUTER_API_KEY
        ? 'openrouter'
        : undefined
    )
  };
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

  const { primary: primaryProvider, fallback: fallbackProvider } = resolveEmbeddingProviders();

  const primary = buildService(primaryProvider);

  if (fallbackProvider && fallbackProvider !== primaryProvider) {
    // Build fallback as a FRESH instance (not the primary singleton) so a
    // litellm primary + mistral fallback don't collapse to one object.
    const fallback = fallbackProvider === 'litellm'
      ? new LiteLLMEmbedService()
      : fallbackProvider === 'openrouter'
      ? makeOpenRouterService()
      : new MistralEmbedService(
          process.env.MISTRAL_API_KEY || process.env.EMBEDDING_API_KEY,
          process.env.MISTRAL_EMBEDDING_MODEL || process.env.EMBEDDING_MODEL_NAME || 'mistral-embed',
          process.env.EMBEDDING_FALLBACK_URL || undefined
        );
    _instance = new FallbackEmbedService(primary, fallback);
  } else {
    _instance = primary;
  }
  return _instance;
}

export default getEmbedService;

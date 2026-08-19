/**
 * HIVE-MIND - LiteLLM Embedding Service
 *
 * OpenAI-compatible embedding client for LiteLLM proxy endpoints.
 * Batches up to 20 texts per API call for efficiency.
 *
 * @module src/embeddings/litellm
 */

import { gatewayFirstFetch } from '../llm/cloudflare-gateway.js';
import { currentOrg } from '../db/prisma.js';
import { getEmbeddingAdmissionController } from './admission.js';

const BATCH_SIZE = 20;

export class LiteLLMEmbedService {
  constructor(
    model = process.env.LITELLM_EMBED_MODEL || 'bge-m3',
    apiKey = process.env.LITELLM_API_KEY || process.env.OPENAI_API_KEY || '',
    baseUrl = process.env.LITELLM_BASE_URL || process.env.OPENAI_API_BASE_URL || 'https://api.blaiq.ai/v1',
    { timeoutMs } = {},
  ) {
    this.model = model;
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.dimension = parseInt(process.env.EMBEDDING_DIMENSION || '1024', 10);
    // Fail fast instead of hanging forever — an unbounded fetch on a stuck
    // gateway connection froze a bulk job once. Tunable via EMBEDDING_TIMEOUT_MS.
    this.timeoutMs = Number(timeoutMs ?? process.env.EMBEDDING_TIMEOUT_MS ?? 30000);
    this.cache = new Map();
    this.inFlight = new Map();
  }

  _timeoutFor(workload, override) {
    if (Number(override) > 0) return Number(override);
    if (workload === 'maintenance') {
      return Math.max(this.timeoutMs, Number(process.env.EMBEDDING_MAINTENANCE_TIMEOUT_MS || 4000));
    }
    if (workload === 'ingestion') {
      return Math.max(this.timeoutMs, Number(process.env.EMBEDDING_INGEST_TIMEOUT_MS || 2000));
    }
    return Math.max(100, Number(process.env.EMBEDDING_INTERACTIVE_TIMEOUT_MS || this.timeoutMs));
  }

  async _post(texts, { workload = 'interactive', tenantId, signal, timeoutMs } = {}) {
    const effectiveTimeout = this._timeoutFor(workload, timeoutMs);
    return getEmbeddingAdmissionController().run(async () => {
      const ctrl = new AbortController();
      const abortFromParent = () => {
        if (!ctrl.signal.aborted) ctrl.abort(signal?.reason);
      };
      if (signal?.aborted) abortFromParent();
      else signal?.addEventListener('abort', abortFromParent, { once: true });
      const timer = setTimeout(() => ctrl.abort(), effectiveTimeout);
      let res;
      try {
        res = await gatewayFirstFetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify({ model: this.model, input: texts }),
          signal: ctrl.signal,
        });
      } catch (err) {
        throw new Error(err.name === 'AbortError'
          ? `LiteLLM embedding timeout after ${effectiveTimeout}ms`
          : `LiteLLM embedding fetch failed: ${err.message}`);
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromParent);
      }
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`LiteLLM embedding error ${res.status}: ${body}`);
      }
      const json = await res.json();
      if (!Array.isArray(json?.data) || json.data.length !== texts.length) {
        throw new Error(`LiteLLM embedding invalid row count: got ${json?.data?.length ?? 'none'}, want ${texts.length}`);
      }
      const indices = json.data.map((row) => row?.index).sort((a, b) => a - b);
      if (indices.some((index, position) => index !== position)) {
        throw new Error(`LiteLLM embedding invalid indices: ${JSON.stringify(indices)}`);
      }
      const vectors = json.data
        .sort((a, b) => a.index - b.index)
        .map(d => d.embedding.slice(0, this.dimension));
      for (let i = 0; i < vectors.length; i += 1) {
        if (vectors[i].length !== this.dimension || !vectors[i].every(Number.isFinite)) {
          throw new Error(`LiteLLM embedding invalid vector at index ${i}: got dim=${vectors[i].length}, want ${this.dimension}`);
        }
      }
      return vectors;
    }, { tenantId: tenantId || currentOrg() || 'shared', workload, signal });
  }

  async embed(input, options = {}) {
    const texts = Array.isArray(input) ? input : [input];
    const cacheKey = JSON.stringify(texts);
    const tenantKey = options.tenantId || currentOrg() || 'shared';
    // Provider work is coalesced only inside the same tenant/workload. This
    // preserves fair admission and per-tenant usage attribution while the
    // deterministic vector cache may safely be shared for identical text.
    const inFlightKey = `${tenantKey}\u0000${options.workload || 'interactive'}\u0000${cacheKey}`;
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    if (this.inFlight.has(inFlightKey)) return this.inFlight.get(inFlightKey);

    const pending = (async () => {
      const results = [];
      for (let i = 0; i < texts.length; i += BATCH_SIZE) {
        const batch = texts.slice(i, i + BATCH_SIZE);
        const vecs = await this._post(batch, options);
        results.push(...vecs);
      }
      this.cache.set(cacheKey, results);
      return results;
    })();
    this.inFlight.set(inFlightKey, pending);
    try { return await pending; }
    finally { this.inFlight.delete(inFlightKey); }
  }

  async embedOne(text, options = {}) {
    const [vec] = await this.embed(text, options);
    return vec;
  }

  getDimension() {
    return this.dimension;
  }

  clearCache() {
    this.cache.clear();
    this.inFlight.clear();
  }

  getCacheStats() {
    return {
      size: this.cache.size,
      in_flight: this.inFlight.size,
      provider: 'litellm',
      model: this.model,
      admission: getEmbeddingAdmissionController().stats(),
    };
  }

  async testConnection() {
    try {
      const vec = await this.embedOne('connection test');
      const ok = vec && vec.length === this.dimension;
      if (ok) console.log(`LiteLLM embed OK - dim=${this.dimension}, model=${this.model}`);
      else console.error(`LiteLLM embed dimension mismatch: got ${vec?.length}, want ${this.dimension}`);
      return ok;
    } catch (err) {
      console.error('LiteLLM embed test failed:', err.message);
      return false;
    }
  }
}

let _instance = null;
export function getLiteLLMEmbedService() {
  if (!_instance) _instance = new LiteLLMEmbedService();
  return _instance;
}

export default LiteLLMEmbedService;

/**
 * HIVE-MIND - LiteLLM Embedding Service
 *
 * OpenAI-compatible embedding client for LiteLLM proxy endpoints.
 * Batches up to 20 texts per API call for efficiency.
 *
 * @module src/embeddings/litellm
 */

import { gatewayFirstFetch } from '../llm/cloudflare-gateway.js';

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
  }

  async _post(texts) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs);
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
        ? `LiteLLM embedding timeout after ${this.timeoutMs}ms`
        : `LiteLLM embedding fetch failed: ${err.message}`);
    } finally {
      clearTimeout(timer);
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
  }

  async embed(input) {
    const texts = Array.isArray(input) ? input : [input];
    const key = JSON.stringify(texts);
    if (this.cache.has(key)) return this.cache.get(key);

    const results = [];
    for (let i = 0; i < texts.length; i += BATCH_SIZE) {
      const batch = texts.slice(i, i + BATCH_SIZE);
      const vecs = await this._post(batch);
      results.push(...vecs);
    }

    this.cache.set(key, results);
    return results;
  }

  async embedOne(text) {
    const [vec] = await this.embed(text);
    return vec;
  }

  getDimension() {
    return this.dimension;
  }

  clearCache() {
    this.cache.clear();
  }

  getCacheStats() {
    return { size: this.cache.size, provider: 'litellm', model: this.model };
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

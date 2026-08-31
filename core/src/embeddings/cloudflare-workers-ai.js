import { currentOrg } from '../db/prisma.js';
import { getEmbeddingAdmissionController } from './admission.js';

const BATCH_SIZE = 48;
const DEFAULT_BATCH_CHAR_BUDGET = 45_000;

export function cloudflareEmbeddingBatches(texts, {
  maxItems = BATCH_SIZE,
  maxChars = Number(process.env.CLOUDFLARE_EMBED_BATCH_MAX_CHARS || DEFAULT_BATCH_CHAR_BUDGET),
} = {}) {
  const itemLimit = Math.max(1, Number(maxItems) || BATCH_SIZE);
  const charLimit = Math.max(1, Number(maxChars) || DEFAULT_BATCH_CHAR_BUDGET);
  const batches = [];
  let batch = [];
  let chars = 0;
  for (const text of texts) {
    const next = String(text);
    const nextChars = next.length;
    if (batch.length && (batch.length >= itemLimit || chars + nextChars > charLimit)) {
      batches.push(batch);
      batch = [];
      chars = 0;
    }
    batch.push(next);
    chars += nextChars;
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export class CloudflareWorkersAIEmbedService {
  constructor({
    accountId = process.env.CLOUDFLARE_ACCOUNT_ID || '',
    apiToken = process.env.CLOUDFLARE_WORKERS_AI_TOKEN || process.env.CLOUDFLARE_AI_GATEWAY_TOKEN || '',
    gatewayId = process.env.CLOUDFLARE_AI_GATEWAY_ID || '',
    model = process.env.CLOUDFLARE_EMBED_MODEL || '@cf/baai/bge-m3',
    timeoutMs = Number(process.env.CLOUDFLARE_EMBED_TIMEOUT_MS || 8000),
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.accountId = String(accountId).trim();
    this.apiToken = String(apiToken).trim();
    this.gatewayId = String(gatewayId).trim();
    this.model = String(model).trim();
    this.timeoutMs = Number(timeoutMs);
    this.fetchImpl = fetchImpl;
    this.dimension = Number(process.env.EMBEDDING_DIMENSION || 1024);
    this.cache = new Map();
    this.inFlight = new Map();
  }

  _url() {
    return `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.accountId)}/ai/run/${this.model}`;
  }

  async _post(texts, { workload = 'interactive', tenantId, signal, timeoutMs } = {}) {
    if (!this.accountId || !this.apiToken || !this.gatewayId) {
      throw new Error('Cloudflare Workers AI embedding requires account ID, API token, and AI Gateway ID');
    }
    const effectiveTimeout = Number(timeoutMs) > 0 ? Number(timeoutMs) : this.timeoutMs;
    return getEmbeddingAdmissionController().run(async () => {
      const ctrl = new AbortController();
      const abortFromParent = () => { if (!ctrl.signal.aborted) ctrl.abort(signal?.reason); };
      if (signal?.aborted) abortFromParent();
      else signal?.addEventListener('abort', abortFromParent, { once: true });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        ctrl.abort(new Error(`embedding deadline after ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      try {
        const response = await this.fetchImpl(this._url(), {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${this.apiToken}`,
            'Content-Type': 'application/json',
            'cf-aig-gateway-id': this.gatewayId,
            'cf-aig-skip-cache': 'true',
          },
          body: JSON.stringify({ text: texts }),
          signal: ctrl.signal,
        });
        if (!response.ok) {
          const body = (await response.text()).slice(0, 1000);
          throw new Error(`Cloudflare Workers AI embedding error ${response.status}: ${body}`);
        }
        const json = await response.json();
        const result = json?.result || json;
        const vectors = Array.isArray(result?.data) ? result.data : result?.embeddings;
        if (!Array.isArray(vectors) || vectors.length !== texts.length) {
          throw new Error(`Cloudflare Workers AI embedding invalid row count: got ${vectors?.length ?? 'none'}, want ${texts.length}`);
        }
        for (let i = 0; i < vectors.length; i += 1) {
          if (!Array.isArray(vectors[i]) || vectors[i].length !== this.dimension || !vectors[i].every(Number.isFinite)) {
            throw new Error(`Cloudflare Workers AI embedding invalid vector at index ${i}: got dim=${vectors[i]?.length}, want ${this.dimension}`);
          }
        }
        return vectors;
      } catch (error) {
        if (error?.message?.startsWith('Cloudflare Workers AI embedding error')
          || error?.message?.startsWith('Cloudflare Workers AI embedding invalid')) throw error;
        const wrapped = new Error(timedOut
          ? `Cloudflare Workers AI embedding timeout after ${effectiveTimeout}ms`
          : (signal?.aborted ? 'Cloudflare Workers AI embedding cancelled by caller'
            : `Cloudflare Workers AI embedding fetch failed: ${error.message}`));
        wrapped.code = timedOut ? 'EMBEDDING_TIMEOUT' : (signal?.aborted ? 'EMBEDDING_CANCELLED' : 'EMBEDDING_PROVIDER_ERROR');
        throw wrapped;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener('abort', abortFromParent);
      }
    }, { tenantId: tenantId || currentOrg() || 'shared', workload, signal });
  }

  async embed(input, options = {}) {
    const texts = (Array.isArray(input) ? input : [input]).map(String);
    const cacheKey = JSON.stringify(texts);
    if (this.cache.has(cacheKey)) return this.cache.get(cacheKey);
    const inFlightKey = `${options.tenantId || currentOrg() || 'shared'}\u0000${options.workload || 'interactive'}\u0000${cacheKey}`;
    if (this.inFlight.has(inFlightKey)) return this.inFlight.get(inFlightKey);
    const pending = (async () => {
      const output = [];
      for (const batch of cloudflareEmbeddingBatches(texts)) {
        output.push(...await this._post(batch, options));
      }
      this.cache.set(cacheKey, output);
      return output;
    })();
    this.inFlight.set(inFlightKey, pending);
    try { return await pending; } finally { this.inFlight.delete(inFlightKey); }
  }

  async embedOne(text, options = {}) { return (await this.embed(text, options))[0]; }
  getDimension() { return this.dimension; }
  clearCache() { this.cache.clear(); this.inFlight.clear(); }
  getCacheStats() { return { provider: 'cloudflare-workers-ai', model: this.model, size: this.cache.size, in_flight: this.inFlight.size }; }
  async testConnection() {
    try { return (await this.embedOne('connection test')).length === this.dimension; } catch { return false; }
  }
}

export default CloudflareWorkersAIEmbedService;

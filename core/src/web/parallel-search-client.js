/**
 * Parallel Search API client for governed HIVE-MIND web discovery.
 *
 * Credentials stay server-side. When Cloudflare AI Gateway coordinates are
 * configured, requests are routed through its native Parallel provider path.
 */

const DEFAULT_DIRECT_BASE = 'https://api.parallel.ai';

function trimSlash(value) {
  return String(value || '').replace(/\/+$/, '');
}

export function resolveParallelSearchEndpoint(env = process.env) {
  if (env.PARALLEL_SEARCH_BASE_URL) {
    return `${trimSlash(env.PARALLEL_SEARCH_BASE_URL)}/v1beta/search`;
  }

  const accountId = env.CLOUDFLARE_ACCOUNT_ID || env.CF_ACCOUNT_ID;
  const gatewayId = env.CLOUDFLARE_AI_GATEWAY_ID || env.CF_AI_GATEWAY_ID;
  if (accountId && gatewayId) {
    return `https://gateway.ai.cloudflare.com/v1/${encodeURIComponent(accountId)}/${encodeURIComponent(gatewayId)}/parallel/v1beta/search`;
  }

  return `${DEFAULT_DIRECT_BASE}/v1beta/search`;
}

function normalizeUrl(value) {
  try {
    const url = new URL(String(value));
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    return url.href;
  } catch {
    return null;
  }
}

function resultSnippet(result) {
  if (typeof result?.excerpt === 'string') return result.excerpt;
  if (typeof result?.content === 'string') return result.content;
  if (typeof result?.text === 'string') return result.text;
  if (Array.isArray(result?.excerpts)) {
    return result.excerpts
      .map((entry) => typeof entry === 'string' ? entry : entry?.text || entry?.content || '')
      .filter(Boolean)
      .join('\n\n');
  }
  return '';
}

export class ParallelSearchClient {
  constructor({ apiKey, endpoint, fetchImpl = globalThis.fetch, env = process.env } = {}) {
    this.apiKey = apiKey || env.PARALLEL_API_KEY;
    this.endpoint = endpoint || resolveParallelSearchEndpoint(env);
    this.fetch = fetchImpl;
  }

  isAvailable() {
    return Boolean(this.apiKey && this.fetch);
  }

  async search({ query, domains = [], limit = 10, objective } = {}) {
    if (!this.apiKey) {
      const error = new Error('Parallel API key not configured');
      error.isAuthError = true;
      throw error;
    }
    if (!query || typeof query !== 'string') throw new Error('Search query is required');

    const safeLimit = Math.max(1, Math.min(Number(limit) || 10, 20));
    const normalizedDomains = (Array.isArray(domains) ? domains : [])
      .map((domain) => {
        const value = String(domain).trim();
        if (!value) return '';
        try { return new URL(value.startsWith('http') ? value : `https://${value}`).hostname; }
        catch { return ''; }
      })
      .filter(Boolean);
    const scopedQuery = normalizedDomains.length > 0
      ? `${query} ${normalizedDomains.map((domain) => `site:${domain}`).join(' ')}`
      : query;
    const startedAt = Date.now();
    const response = await this.fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': this.apiKey,
      },
      body: JSON.stringify({
        objective: objective || query,
        search_queries: [scopedQuery],
        processor: 'base',
        max_results: safeLimit,
        max_chars_per_result: 6000,
      }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      const error = new Error(`Parallel Search failed (${response.status})${body ? `: ${body.slice(0, 300)}` : ''}`);
      error.status = response.status;
      error.isAuthError = response.status === 401 || response.status === 403;
      error.isRateLimit = response.status === 429;
      error.isQuotaExceeded = response.status === 402;
      throw error;
    }

    const payload = await response.json();
    const rawResults = Array.isArray(payload?.results) ? payload.results : [];
    const results = rawResults.flatMap((result, index) => {
      const url = normalizeUrl(result?.url || result?.source_url || result?.link);
      if (!url) return [];
      return [{
        title: result?.title || new URL(url).hostname,
        url,
        snippet: resultSnippet(result),
        score: Number.isFinite(result?.score) ? result.score : Math.max(0, 1 - index / Math.max(rawResults.length, 1)),
        favicon: result?.favicon || null,
      }];
    });

    return {
      results,
      answer: payload?.answer || null,
      runtime_used: 'parallel-search',
      duration_ms: Date.now() - startedAt,
      request_id: payload?.search_id || payload?.request_id || null,
      errors: [],
    };
  }
}

let singleton;
export function getParallelSearchClient() {
  if (!singleton) singleton = new ParallelSearchClient();
  return singleton;
}

import { describe, expect, it, vi } from 'vitest';
import { ParallelSearchClient, resolveParallelSearchEndpoint } from '../../src/web/parallel-search-client.js';

describe('ParallelSearchClient', () => {
  it('routes through Cloudflare AI Gateway when configured', () => {
    expect(resolveParallelSearchEndpoint({
      CLOUDFLARE_ACCOUNT_ID: 'account',
      CLOUDFLARE_AI_GATEWAY_ID: 'hive gateway',
    })).toBe('https://gateway.ai.cloudflare.com/v1/account/hive%20gateway/parallel/v1beta/search');
  });

  it('returns canonical URL-bearing results and a non-empty runtime', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      search_id: 'search-1',
      results: [{
        title: 'European Commission',
        url: 'https://commission.europa.eu/index_en',
        excerpts: ['Official EU source.'],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const client = new ParallelSearchClient({ apiKey: 'secret', endpoint: 'https://gateway.test/v1beta/search', fetchImpl });

    const result = await client.search({ query: 'EU AI adoption', domains: ['https://europa.eu'], limit: 4 });

    expect(result).toMatchObject({
      runtime_used: 'parallel-search',
      request_id: 'search-1',
      results: [{
        title: 'European Commission',
        url: 'https://commission.europa.eu/index_en',
        snippet: 'Official EU source.',
      }],
    });
    const request = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(request.search_queries).toEqual(['EU AI adoption site:europa.eu']);
    expect(fetchImpl.mock.calls[0][1].headers['x-api-key']).toBe('secret');
  });

  it('classifies provider failures for the existing fallback policy', async () => {
    const client = new ParallelSearchClient({
      apiKey: 'secret',
      endpoint: 'https://gateway.test/v1beta/search',
      fetchImpl: vi.fn().mockResolvedValue(new Response('rate limited', { status: 429 })),
    });

    await expect(client.search({ query: 'current fact' })).rejects.toMatchObject({
      status: 429,
      isRateLimit: true,
    });
  });

  it('fails closed when the server credential is absent', async () => {
    const client = new ParallelSearchClient({ env: {}, fetchImpl: vi.fn() });
    await expect(client.search({ query: 'current fact' })).rejects.toMatchObject({ isAuthError: true });
  });
});

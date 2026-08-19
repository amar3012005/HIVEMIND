import assert from 'node:assert/strict';
import test from 'node:test';

import { buildEmbeddingChain, FallbackEmbedService } from '../../src/embeddings/factory.js';

test('production embedding chain uses one bge-m3 vector space across three failure domains', () => {
  const keys = [
    'EMBEDDING_PROVIDER', 'EMBEDDING_FALLBACK_PROVIDER', 'EMBEDDING_FALLBACK2_PROVIDER',
    'SINGULANCE_EMBED_BASE_URL', 'BLAIQ_EMBED_BASE_URL', 'OPENROUTER_BASE_URL',
  ];
  const before = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    process.env.EMBEDDING_PROVIDER = 'singulance';
    process.env.EMBEDDING_FALLBACK_PROVIDER = 'blaiq';
    process.env.EMBEDDING_FALLBACK2_PROVIDER = 'openrouter';
    process.env.SINGULANCE_EMBED_BASE_URL = 'https://embeddings.singulancelabs.com/v1';
    process.env.BLAIQ_EMBED_BASE_URL = 'https://api.blaiq.ai/v1';
    process.env.OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1';
    const links = buildEmbeddingChain();
    assert.deepEqual(links.map((link) => link.name), ['singulance', 'blaiq', 'openrouter']);
    assert.deepEqual(links.map((link) => link.service.model), ['bge-m3', 'bge-m3', 'baai/bge-m3']);
    assert.deepEqual(links.map((link) => link.service.getDimension()), [1024, 1024, 1024]);
    assert.deepEqual(links.map((link) => link.service.baseUrl), [
      'https://embeddings.singulancelabs.com/v1',
      'https://api.blaiq.ai/v1',
      'https://openrouter.ai/api/v1',
    ]);
  } finally {
    for (const key of keys) {
      if (before[key] === undefined) delete process.env[key];
      else process.env[key] = before[key];
    }
  }
});

test('fallback embedding preserves workload, tenant, and cancellation options', async () => {
  const calls = [];
  const primary = { embed: async (_input, options) => { calls.push(['primary', options]); throw new Error('primary down'); } };
  const fallback = { embed: async (_input, options) => { calls.push(['fallback', options]); return [[1, 2, 3]]; } };
  const service = new FallbackEmbedService([
    { name: 'primary', service: primary },
    { name: 'fallback', service: fallback },
  ]);
  const ctrl = new AbortController();
  const options = { workload: 'maintenance', tenantId: 'tenant-a', signal: ctrl.signal };
  assert.deepEqual(await service.embed(['text'], options), [[1, 2, 3]]);
  assert.deepEqual(calls.map(([name]) => name), ['primary', 'fallback']);
  assert.equal(calls[1][1], options);
});

test('a cooling provider is deprioritized but never removed from the fail-closed chain', async () => {
  const calls = [];
  let primaryHealthy = false;
  const service = new FallbackEmbedService([
    { name: 'primary', service: { embed: async () => {
      calls.push('primary');
      if (!primaryHealthy) throw new Error('primary transient');
      return [[1]];
    } } },
    { name: 'fallback', service: { embed: async () => { calls.push('fallback'); throw new Error('fallback down'); } } },
  ]);
  await assert.rejects(service.embed(['first']), /all 2 embedding providers failed/);
  primaryHealthy = true;
  calls.length = 0;
  assert.deepEqual(await service.embed(['second']), [[1]]);
  assert.deepEqual(calls, ['primary']);
});

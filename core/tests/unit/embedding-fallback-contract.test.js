import assert from 'node:assert/strict';
import test from 'node:test';

import { FallbackEmbedService } from '../../src/embeddings/factory.js';

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

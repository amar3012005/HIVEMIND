import assert from 'node:assert/strict';
import test from 'node:test';

import { EmbeddingAdmissionController } from '../../src/embeddings/admission.js';

const deferred = () => {
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  return { promise, resolve };
};

test('embedding admission enforces global and per-tenant concurrency', async () => {
  const gate = new EmbeddingAdmissionController({ maxConcurrent: 3, maxPerTenant: 2, maxQueue: 20 });
  const blockers = Array.from({ length: 4 }, deferred);
  let active = 0;
  let peak = 0;
  const jobs = blockers.map((blocker, index) => gate.run(async () => {
    active += 1;
    peak = Math.max(peak, active);
    await blocker.promise;
    active -= 1;
    return index;
  }, { tenantId: index < 3 ? 'tenant-a' : 'tenant-b', workload: 'ingestion' }));

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(gate.stats().active, 3);
  assert.equal(peak, 3);
  assert.equal(gate.activeByTenant.get('tenant-a'), 2);
  assert.equal(gate.activeByTenant.get('tenant-b'), 1);
  blockers.forEach((item) => item.resolve());
  assert.deepEqual((await Promise.all(jobs)).sort(), [0, 1, 2, 3]);
  assert.equal(gate.stats().queued, 0);
});

test('interactive embedding jumps ahead of queued ingestion without dropping bulk work', async () => {
  const gate = new EmbeddingAdmissionController({ maxConcurrent: 1, maxPerTenant: 1, maxQueue: 20 });
  const blocker = deferred();
  const order = [];
  const first = gate.run(async () => { order.push('bulk-1'); await blocker.promise; }, { tenantId: 'a', workload: 'ingestion' });
  const second = gate.run(async () => { order.push('bulk-2'); }, { tenantId: 'a', workload: 'ingestion' });
  const interactive = gate.run(async () => { order.push('interactive'); }, { tenantId: 'b', workload: 'interactive' });
  blocker.resolve();
  await Promise.all([first, second, interactive]);
  assert.deepEqual(order, ['bulk-1', 'interactive', 'bulk-2']);
});

test('queued embedding honors cancellation and bounded queue admission', async () => {
  const gate = new EmbeddingAdmissionController({ maxConcurrent: 1, maxPerTenant: 1, maxQueue: 1 });
  const blocker = deferred();
  const first = gate.run(() => blocker.promise, { tenantId: 'a', workload: 'ingestion' });
  const ctrl = new AbortController();
  const queued = gate.run(async () => 'never', { tenantId: 'b', workload: 'maintenance', signal: ctrl.signal });
  await assert.rejects(gate.run(async () => 'overflow', { tenantId: 'c' }), /queue full/);
  ctrl.abort(new Error('caller deadline'));
  await assert.rejects(queued, /caller deadline/);
  blocker.resolve();
  await first;
  assert.equal(gate.stats().aborted, 1);
  assert.equal(gate.stats().rejected, 1);
});

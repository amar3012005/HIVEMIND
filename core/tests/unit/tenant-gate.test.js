import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';

import {
  acquireTenantRequestSlot,
  acquireTenantSlot,
  getGateStats,
} from '../../src/memory/tenant-gate.js';

test('a saturated tenant does not delay another tenant', async () => {
  const releaseA = await acquireTenantSlot('org-a', '/api/chat', { maxInflight: 1, requestTimeoutMs: 5000 });
  let acquiredA2 = false;
  const a2 = acquireTenantSlot('org-a', '/api/chat', {
    maxInflight: 1, queueTimeoutMs: 1000, requestTimeoutMs: 5000,
  }).then((release) => { acquiredA2 = true; return release; });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acquiredA2, false);
  const releaseB = await acquireTenantSlot('org-b', '/api/chat', { maxInflight: 1, requestTimeoutMs: 5000 });
  assert.equal(getGateStats().slots.find((slot) => slot.key === 'org-b::/api/chat')?.inflight, 1);

  releaseB();
  releaseA();
  const releaseA2 = await a2;
  releaseA2();
  assert.equal(getGateStats().totalKeys, 0);
});

test('an aborted waiter is removed without consuming the next slot', async () => {
  const release = await acquireTenantSlot('org-abort', '/api/recall', { maxInflight: 1, requestTimeoutMs: 5000 });
  const controller = new AbortController();
  const waiting = acquireTenantSlot('org-abort', '/api/recall', {
    maxInflight: 1, queueTimeoutMs: 1000, requestTimeoutMs: 5000, signal: controller.signal,
  });
  controller.abort(new Error('caller left'));
  await assert.rejects(waiting, /caller left/);
  assert.equal(getGateStats().slots[0]?.waiting, 0);
  release();
  assert.equal(getGateStats().totalKeys, 0);
});

test('a tenant queue is bounded without affecting another tenant', async () => {
  const releaseA = await acquireTenantSlot('org-bounded', '/api/recall', { maxInflight: 1, requestTimeoutMs: 5000 });
  const queuedA = acquireTenantSlot('org-bounded', '/api/recall', {
    maxInflight: 1, maxQueued: 1, queueTimeoutMs: 1000, requestTimeoutMs: 5000,
  });
  await assert.rejects(
    acquireTenantSlot('org-bounded', '/api/recall', {
      maxInflight: 1, maxQueued: 1, queueTimeoutMs: 1000, requestTimeoutMs: 5000,
    }),
    (error) => error?.code === 'TENANT_QUEUE_FULL',
  );
  const releaseB = await acquireTenantSlot('org-neighbor', '/api/recall', { maxInflight: 1, requestTimeoutMs: 5000 });
  releaseB();
  releaseA();
  const releaseQueuedA = await queuedA;
  releaseQueuedA();
  assert.equal(getGateStats().totalKeys, 0);
});

test('HTTP response lifecycle releases a slot and disconnected waiters do not leak', async () => {
  const req1 = new EventEmitter();
  const res1 = new EventEmitter();
  const release1 = await acquireTenantRequestSlot(req1, res1, 'org-http', '/api/chat', {
    maxInflight: 1, queueTimeoutMs: 1000, requestTimeoutMs: 5000,
  });

  const req2 = new EventEmitter();
  const res2 = new EventEmitter();
  const waiting = acquireTenantRequestSlot(req2, res2, 'org-http', '/api/chat', {
    maxInflight: 1, queueTimeoutMs: 1000, requestTimeoutMs: 5000,
  });
  await new Promise((resolve) => setImmediate(resolve));
  res2.emit('close');
  await assert.rejects(waiting, /Client disconnected/);

  res1.emit('finish');
  release1();
  assert.equal(getGateStats().totalKeys, 0);
});

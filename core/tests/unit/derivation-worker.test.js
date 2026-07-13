import test from 'node:test';
import assert from 'node:assert/strict';
import { processDerivationBatch } from '../../src/memory/derivation-worker.js';

test('derivation worker claims and executes a same-tenant job asynchronously', async () => {
  const updates = [];
  const calls = [];
  const job = {
    id: 'job-1', sourceMemoryId: 'source-1', targetMemoryId: 'target-1',
    confidence: 0.8, metadata: { reason: 'cross-source synthesis' },
    sourceMemory: { userId: 'user-1', orgId: 'org-1' },
    targetMemory: { userId: 'user-1', orgId: 'org-1' },
  };
  const prisma = { derivationJob: {
    findMany: async () => [job],
    updateMany: async () => ({ count: 1 }),
    update: async (args) => updates.push(args),
  } };
  const engine = { applyDerives: async (...args) => calls.push(args) };
  const result = await processDerivationBatch({ prisma, engine, validate: async () => ({ approved: true, confidence: 0.9 }) });

  assert.deepEqual(result, { claimed: 1, completed: 1, rejected: 0, failed: 0 });
  assert.equal(calls[0][2].async_verified, true);
  assert.equal(calls[0][2].confidence, 0.8);
  assert.equal(updates.at(-1).data.status, 'completed');
});

test('derivation worker fails closed on a cross-tenant job', async () => {
  const updates = [];
  let calls = 0;
  const job = {
    id: 'job-2', sourceMemoryId: 'source-1', targetMemoryId: 'target-1',
    confidence: 0.9, metadata: {},
    sourceMemory: { userId: 'user-1', orgId: 'org-1' },
    targetMemory: { userId: 'user-1', orgId: 'org-2' },
  };
  const prisma = { derivationJob: {
    findMany: async () => [job],
    updateMany: async () => ({ count: 1 }),
    update: async (args) => updates.push(args),
  } };
  const result = await processDerivationBatch({
    prisma,
    engine: { applyDerives: async () => { calls += 1; } },
    logger: { warn() {} },
    validate: async () => ({ approved: true, confidence: 0.9 }),
  });
  assert.deepEqual(result, { claimed: 1, completed: 0, rejected: 0, failed: 1 });
  assert.equal(calls, 0);
  assert.equal(updates.at(-1).data.status, 'failed');
});

test('derivation worker rejects an unvalidated inference without creating an edge', async () => {
  const updates = [];
  let calls = 0;
  const job = {
    id: 'job-3', sourceMemoryId: 'source-1', targetMemoryId: 'target-1',
    confidence: 0.9, metadata: {},
    sourceMemory: { userId: 'user-1', orgId: 'org-1', content: 'Source' },
    targetMemory: { userId: 'user-1', orgId: 'org-1', content: 'Unrelated target' },
  };
  const prisma = { derivationJob: {
    findMany: async () => [job],
    updateMany: async () => ({ count: 1 }),
    update: async (args) => updates.push(args),
  } };
  const result = await processDerivationBatch({
    prisma,
    engine: { applyDerives: async () => { calls += 1; } },
    validate: async () => ({ approved: false, confidence: 0.4, reason: 'not an inference' }),
  });
  assert.deepEqual(result, { claimed: 1, completed: 0, rejected: 1, failed: 0 });
  assert.equal(calls, 0);
  assert.equal(updates.at(-1).data.status, 'rejected');
});

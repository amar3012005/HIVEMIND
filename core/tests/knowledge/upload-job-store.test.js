import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeUploadJobStore } from '../../src/knowledge/upload-job-store.js';

test('job lookup always carries tenant and initiating user scope', async () => {
  let where;
  const store = new KnowledgeUploadJobStore({ prisma: { knowledgeIngestJob: { findFirst: async (query) => { where = query.where; return null; } } } });
  await store.findOwned('job', { orgId: 'org', userId: 'user' });
  assert.deepEqual(where, { id: 'job', orgId: 'org', userId: 'user' });
});

test('usage is emitted only when the idempotency ledger inserts', async () => {
  const calls = [];
  const prisma = { $executeRaw: async () => 1 };
  const store = new KnowledgeUploadJobStore({ prisma, planEnforcer: { recordUsage: (...args) => calls.push(args) } });
  await store.settle('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'uploads', 1);
  prisma.$executeRaw = async () => 0;
  await store.settle('33333333-3333-4333-8333-333333333333', '22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111', 'uploads', 1);
  assert.equal(calls.length, 1);
});

test('ready responses always expose an authoritative terminal lifecycle', () => {
  const response = KnowledgeUploadJobStore.response({
    id: 'job', status: 'ready', stage: 'promoted', progress: 95,
    memoryIds: [], storageMode: 'hybrid', createdAt: new Date(), updatedAt: new Date(),
  });
  assert.equal(response.stage, 'ready');
  assert.equal(response.progress, 100);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeUploadJobStore } from '../../src/knowledge/upload-job-store.js';

test('job lookup always carries tenant and initiating user scope', async () => {
  let where;
  const store = new KnowledgeUploadJobStore({ prisma: { knowledgeIngestJob: {
    updateMany: async () => ({ count: 0 }),
    findFirst: async (query) => { where = query.where; return null; },
  } } });
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

test('unique active-upload race reuses the durable winning job', async () => {
  const winner = { id: 'job-winner', status: 'queued' };
  const store = new KnowledgeUploadJobStore({ prisma: { knowledgeIngestJob: {
    updateMany: async () => ({ count: 0 }),
    create: async () => { throw Object.assign(new Error('unique'), { code: 'P2002' }); },
    findFirst: async () => winner,
  } } });
  const result = await store.createOrReuse({ orgId: 'org', scopeKey: 'personal:user', checksum: 'a'.repeat(64) });
  assert.deepEqual(result, { job: winner, created: false });
});

test('ready responses always expose an authoritative terminal lifecycle', () => {
  const response = KnowledgeUploadJobStore.response({
    id: 'job', status: 'ready', stage: 'promoted', progress: 95,
    memoryIds: [], storageMode: 'hybrid', createdAt: new Date(), updatedAt: new Date(),
  });
  assert.equal(response.stage, 'ready');
  assert.equal(response.progress, 100);
});

test('ready evidence-only responses expose durable intent and zero memories', () => {
  const response = KnowledgeUploadJobStore.response({
    id: 'job', status: 'ready', stage: 'ready', progress: 100,
    ingestMode: 'evidence', evidenceOnlyReason: 'user_selected',
    segmentCount: 4, promotedCount: 0, memoryIds: [], storageMode: 'amr_embedded',
    createdAt: new Date(), updatedAt: new Date(),
  });
  assert.equal(response.ingest_mode, 'evidence');
  assert.equal(response.evidence_only, true);
  assert.equal(response.evidence_only_reason, 'user_selected');
  assert.deepEqual(response.memory_ids, []);
});

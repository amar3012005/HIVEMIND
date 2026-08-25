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

test('duplicate lookup gives a live source owner priority over newer terminal duplicates', async () => {
  const active = { id: 'active', status: 'processing' };
  const calls = [];
  const store = new KnowledgeUploadJobStore({ prisma: { knowledgeIngestJob: {
    updateMany: async () => ({ count: 0 }),
    findFirst: async (query) => {
      calls.push(query);
      return query.where.status?.in ? active : { id: 'newer-failed', status: 'failed' };
    },
  } } });

  const result = await store.findDuplicate({ orgId: 'org', scopeKey: 'personal:user', checksum: 'a'.repeat(64) });
  assert.equal(result, active);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].where, {
    orgId: 'org', scopeKey: 'personal:user', checksum: 'a'.repeat(64), status: { in: ['queued', 'processing'] },
  });
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

test('legacy response mode falls back to its persisted metadata latch', () => {
  const response = KnowledgeUploadJobStore.response({
    id: 'job', status: 'queued', stage: 'queued', progress: 0,
    metadata: { ingest_mode: 'evidence' }, memoryIds: [], storageMode: 'hybrid',
  });
  assert.equal(response.ingest_mode, 'evidence');
});

test('promotion degradation is an explicit terminal memory-generation failure', () => {
  const response = KnowledgeUploadJobStore.response({
    id: 'job', status: 'ready', stage: 'ready', progress: 100,
    ingestMode: 'both', evidenceOnlyReason: 'promotion_failed',
    segmentCount: 4, promotedCount: 0, memoryIds: [], storageMode: 'hybrid',
  });
  assert.equal(response.memory_generation_failed, true);
  assert.equal(response.evidence_only_reason, 'promotion_failed');
});

test('live progress persists tqdm detail in metadata and returns it to pollers', async () => {
  let written;
  const existing = { id: 'job', attempt: 1, metadata: { ingest_mode: 'both' } };
  const store = new KnowledgeUploadJobStore({ prisma: { knowledgeIngestJob: {
    findFirst: async () => existing,
    updateMany: async ({ data }) => { written = data; return { count: 1 }; },
  } } });

  await store.progress('job', 'org', 'embedding', 60, {
    processed: 8, total: 16, elapsed_ms: 4200, started_at: '2026-08-25T21:46:07.232Z',
  });

  assert.equal(written.stage, 'embedding');
  assert.equal(written.progress, 60);
  assert.deepEqual(written.metadata.progress_detail, {
    processed: 8, total: 16, elapsed_ms: 4200, started_at: '2026-08-25T21:46:07.232Z',
  });
  const response = KnowledgeUploadJobStore.response({ ...existing, status: 'processing', ...written });
  assert.equal(response.progress_detail.processed, 8);
  assert.equal(response.progress_detail.total, 16);
});

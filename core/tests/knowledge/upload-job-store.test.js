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

test('boot orphan reaping excludes Cloudflare Workflow jobs that survive an API restart', async () => {
  let where;
  const store = new KnowledgeUploadJobStore({ prisma: { knowledgeIngestJob: {
    updateMany: async (query) => { where = query.where; return { count: 0 }; },
  } } });
  await store.reapStale({ bootedAt: new Date(), bootOrphanMin: 5 });
  const bootOrphan = where.OR.at(-1);
  assert.deepEqual(bootOrphan.orchestrationMode, { not: 'cloudflare_workflow' });
  assert.deepEqual(where.OR[0].orchestrationMode, { not: 'cloudflare_workflow' });
  assert.ok(where.OR[0].updatedAt?.lt instanceof Date);
  assert.equal(where.OR[0].createdAt, undefined);
  assert.deepEqual(where.OR[1].orchestrationMode, { not: 'cloudflare_workflow' });
});

test('Workflow progress and failure writes are fenced by processing version', async () => {
  const writes = [];
  const store = new KnowledgeUploadJobStore({ prisma: { knowledgeIngestJob: {
    findFirst: async () => ({ id: 'job', attempt: 0, metadata: {}, processingVersion: 4 }),
    updateMany: async (query) => { writes.push(query); return { count: 1 }; },
  } } });
  await store.progress('job', 'org', 'embedding', 50, {}, { processingVersion: 4 });
  await store.fail('job', 'org', new Error('failed'), { processingVersion: 4 });
  assert.equal(writes[0].where.processingVersion, 4);
  assert.equal(writes[1].where.processingVersion, 4);
});

test('a stale Workflow failure cannot release the current retry reservation', async () => {
  const released = [];
  const store = new KnowledgeUploadJobStore({
    prisma: { knowledgeIngestJob: {
      findFirst: async () => ({ id: 'job', processingVersion: 5 }),
      updateMany: async () => ({ count: 0 }),
    } },
    creditService: { release: async (input) => released.push(input) },
  });

  const changed = await store.fail('job', 'org', new Error('late v4 failure'), { processingVersion: 4 });

  assert.equal(changed, false);
  assert.deepEqual(released, []);
});

test('a winning Workflow failure releases only its own versioned reservation', async () => {
  const released = [];
  const store = new KnowledgeUploadJobStore({
    prisma: { knowledgeIngestJob: {
      findFirst: async () => ({ id: 'job', processingVersion: 5 }),
      updateMany: async () => ({ count: 1 }),
    } },
    creditService: { release: async (input) => released.push(input) },
  });

  const changed = await store.fail('job', 'org', new Error('v5 failure'), { processingVersion: 5 });

  assert.equal(changed, true);
  assert.deepEqual(released, [{ orgId: 'org', idempotencyKey: 'knowledge-credit:job:5' }]);
});

test('Workflow retry settlement recreates a missing versioned credit reservation idempotently', async () => {
  const calls = [];
  const job = { id: 'job', orgId: 'org', userId: 'user', status: 'processing', processingVersion: 2, ingestMode: 'both' };
  const store = new KnowledgeUploadJobStore({
    prisma: { knowledgeIngestJob: {
      findFirst: async () => job,
      updateMany: async () => ({ count: 1 }),
    } },
    creditService: {
      adjustReservation: async () => { throw new Error('credit reservation not found'); },
      reserve: async (input) => { calls.push(['reserve', input]); return { admitted: true }; },
      settle: async (input) => { calls.push(['settle', input]); return { settled: true }; },
      release: async () => {},
    },
  });

  const completed = await store.complete('job', 'org', 'user', {
    documentId: 'doc', pages: 90, segmentCount: 221, candidateCount: 17,
    promotedCount: 15, promotedMemoryIds: [],
  }, { processingVersion: 2 });

  assert.equal(completed, true);
  assert.equal(calls[0][0], 'reserve');
  assert.equal(calls[0][1].idempotencyKey, 'knowledge-credit:job:2');
  assert.equal(calls[0][1].units, 90);
  assert.deepEqual(calls.at(-1), ['settle', { orgId: 'org', idempotencyKey: 'knowledge-credit:job:2' }]);
});

test('failure recording normalizes numeric platform error codes to the string contract', async () => {
  let written;
  const store = new KnowledgeUploadJobStore({ prisma: { knowledgeIngestJob: {
    findFirst: async () => ({ id: 'job', processingVersion: 1 }),
    updateMany: async ({ data }) => { written = data; return { count: 1 }; },
  } } });
  await store.fail('job', 'org', Object.assign(new Error('timed out'), { code: 23 }));
  assert.equal(written.errorCode, '23');
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

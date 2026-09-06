import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeUploadService } from '../../src/knowledge/upload-service.js';

const ids = {
  user: '11111111-1111-4111-8111-111111111111',
  org: '22222222-2222-4222-8222-222222222222',
  job: '33333333-3333-4333-8333-333333333333',
};

function dependencies({ storageMode = 'hybrid', ready = true, duplicate = null, isRemoteOrg = () => false } = {}) {
  const created = [];
  const updates = [];
  const prisma = {
    userOrganization: { findFirst: async () => ({ role: 'admin', roles: [] }) },
    team: { findFirst: async () => null }, project: { findMany: async () => [] },
    organization: { findFirst: async () => ({ memoryStorageMode: storageMode }) },
  };
  const jobStore = {
    findDuplicate: async () => duplicate,
    findOwned: async () => created.at(-1) || duplicate,
    create: async (data) => { const job = { id: ids.job, ...data, memoryIds: [], createdAt: new Date(), updatedAt: new Date() }; created.push(job); return job; },
    createOrReuse: async (data) => {
      const job = { id: ids.job, ...data, memoryIds: [], createdAt: new Date(), updatedAt: new Date() };
      created.push(job);
      return { job, created: true };
    },
    updateOwned: async (...args) => { updates.push(args); return { count: 1 }; }, fail: async () => {},
  };
  const queue = {
    isAvailable: async () => true, persistFile: () => '/tmp/file',
    enqueue: async () => ({ queue_job_id: 'queue-1' }),
  };
  return { prisma, jobStore, queue, created, updates, storageReady: () => ready, isRemoteOrg };
}

function request() {
  return {
    userId: ids.user, orgId: ids.org,
    file: { filename: 'report.pdf', contentType: 'application/pdf', data: Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 1)]) },
    targetScope: 'personal', projectIds: [], primaryTeamId: null, metadata: {},
  };
}

test('fails closed instead of falling back when selected AMR storage is unavailable', async () => {
  const deps = dependencies({ storageMode: 'amr_embedded', ready: false });
  const result = await new KnowledgeUploadService(deps).admit(request());
  assert.equal(result.status, 503);
  assert.equal(result.body.error, 'storage_unavailable');
  assert.equal(deps.created.length, 0);
});

test('completed duplicate returns existing identifiers without enqueueing', async () => {
  const duplicate = { id: ids.job, status: 'ready', documentId: ids.job };
  const deps = dependencies({ duplicate });
  let queued = false;
  deps.queue.enqueue = async () => { queued = true; return {}; };
  const result = await new KnowledgeUploadService(deps).admit(request());
  assert.equal(result.status, 409);
  assert.equal(result.body.existing_document_id, ids.job);
  assert.equal(queued, false);
});

test('remote ready uploads remain duplicates without a central document lookup', async () => {
  const duplicate = { id: ids.job, userId: ids.user, status: 'ready', documentId: ids.job, processingVersion: 1 };
  const deps = dependencies({ storageMode: 'byod_amr', duplicate, isRemoteOrg: () => true });
  let queued = false;
  deps.queue.enqueue = async () => { queued = true; return {}; };
  const result = await new KnowledgeUploadService(deps).admit(request());
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'duplicate_document');
  assert.equal(queued, false);
});

test('completed image duplicate resolves its canonical memory instead of re-running vision', async () => {
  const duplicate = {
    id: ids.job, userId: ids.user, status: 'ready', documentId: '44444444-4444-4444-8444-444444444444',
    processingVersion: 1, mediaKind: 'image', filename: 'diagram.png',
  };
  const deps = dependencies({ duplicate });
  deps.prisma.knowledgeDocument = { findFirst: async () => null };
  deps.prisma.memory = { findFirst: async ({ where }) => where.id === duplicate.documentId ? { id: where.id } : null };
  let queued = false;
  deps.queue.enqueue = async () => { queued = true; return {}; };
  const req = request();
  req.file = {
    filename: 'diagram.png', contentType: 'image/png',
    data: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]),
  };
  const result = await new KnowledgeUploadService(deps).admit(req);
  assert.equal(result.status, 409);
  assert.equal(result.body.error, 'duplicate_document');
  assert.equal(result.body.existing_document_id, duplicate.documentId);
  assert.equal(queued, false);
});

test('force reprocesses a ready evidence-only job as both without creating another job', async () => {
  const duplicate = {
    id: ids.job, userId: ids.user, status: 'ready', documentId: '44444444-4444-4444-8444-444444444444',
    processingVersion: 1, metadata: { ingest_mode: 'evidence' }, memoryIds: [],
  };
  const deps = dependencies({ duplicate });
  let queued;
  deps.queue.enqueue = async (input) => { queued = input; return { queue_job_id: 'queue-1' }; };
  const req = request();
  req.metadata = { ingest_mode: 'both' };
  const result = await new KnowledgeUploadService(deps).admit({ ...req, force: true });

  assert.equal(result.ok, true);
  assert.equal(deps.created.length, 0);
  const reset = deps.updates.find(([, , data]) => data?.processingVersion === 2)?.[2];
  assert.equal(reset.ingestMode, 'both');
  assert.equal(reset.metadata.force_reprocess, true);
  assert.equal(reset.metadata.reprocess_document_id, duplicate.documentId);
  assert.equal(queued.metadata.force_reprocess, true);
  assert.equal(queued.metadata.reprocess_document_id, duplicate.documentId);
  assert.equal(queued.metadata.ingest_mode, 'both');
});

test('evidence-to-both upgrade queues stored-evidence promotion without persisting or reparsing bytes', async () => {
  const duplicate = {
    id: ids.job, userId: ids.user, status: 'ready', documentId: '44444444-4444-4444-8444-444444444444',
    processingVersion: 1, ingestMode: 'evidence', metadata: { ingest_mode: 'evidence' }, memoryIds: [],
  };
  const deps = dependencies({ duplicate });
  let persisted = false;
  let queued;
  deps.queue.persistFile = () => { persisted = true; return '/tmp/should-not-exist'; };
  deps.queue.enqueue = async (input) => { queued = input; return { queue_job_id: 'queue-1' }; };
  const req = request();
  req.metadata = { ingest_mode: 'both' };

  const result = await new KnowledgeUploadService(deps).admit(req);

  assert.equal(result.ok, true);
  assert.equal(persisted, false);
  assert.equal(queued.filePath, null);
  assert.equal(queued.metadata.promotion_existing_evidence, true);
  assert.equal(queued.metadata.promotion_document_id, duplicate.documentId);
  assert.equal(queued.metadata.original_ingest_mode, 'evidence');
  const reset = deps.updates.find(([, , data]) => data?.processingVersion === 2)?.[2];
  assert.equal(reset.ingestMode, 'both');
  assert.equal(reset.metadata.promotion_existing_evidence, true);
});

test('accepted upload persists one durable job before enqueue', async () => {
  const deps = dependencies();
  const result = await new KnowledgeUploadService(deps).admit(request());
  assert.equal(result.ok, true);
  assert.equal(deps.created.length, 1);
  assert.equal(deps.created[0].orgId, ids.org);
  assert.equal(deps.created[0].userId, ids.user);
  assert.equal(deps.created[0].scopeKey, `personal:${ids.user}`);
  assert.equal(deps.created[0].ingestMode, 'both');
});

test('enabled local Workflow latches orchestration and never sends file bytes in its queue message', async () => {
  const deps = dependencies();
  let legacyUsed = false;
  deps.queue.persistFile = async () => { legacyUsed = true; return '/tmp/legacy'; };
  deps.queue.enqueue = async () => { legacyUsed = true; return {}; };
  const calls = [];
  deps.cloudflareQueue = {
    isEnabled: async (orgId, userId) => orgId === ids.org && userId === ids.user,
    isAvailable: async () => true,
    persistFile: async (input) => {
      calls.push(['persist', input]);
      return { objectKey: 'org/source', etag: 'etag-1' };
    },
    enqueue: async (input) => {
      calls.push(['enqueue', input]);
      return { queue_job_id: 'workflow-1', workflow_instance_id: 'workflow-1' };
    },
  };

  const result = await new KnowledgeUploadService(deps).admit(request());
  assert.equal(result.ok, true);
  assert.equal(legacyUsed, false);
  assert.equal(deps.created[0].orchestrationMode, 'cloudflare_workflow');
  const queueInput = calls.find(([kind]) => kind === 'enqueue')[1];
  assert.equal(queueInput.filePath, null);
  assert.equal(Object.hasOwn(queueInput, 'fileBuffer'), false);
  const finalUpdate = deps.updates.at(-1)[2];
  assert.equal(finalUpdate.workflowInstanceId, 'workflow-1');
  assert.equal(finalUpdate.sourceObjectKey, 'org/source');
});

test('disabled or failed-closed Workflow flag preserves the legacy BullMQ path', async () => {
  const deps = dependencies();
  let legacyUsed = false;
  deps.queue.persistFile = async () => { legacyUsed = true; return '/tmp/legacy'; };
  deps.cloudflareQueue = { isEnabled: async () => false };
  const result = await new KnowledgeUploadService(deps).admit(request());
  assert.equal(result.ok, true);
  assert.equal(legacyUsed, true);
  assert.equal(deps.created[0].orchestrationMode, 'bullmq');
});

test('unavailable Flagship admission deterministically falls back to BullMQ', async () => {
  const deps = dependencies();
  let persisted = false;
  let queued = false;
  deps.cloudflareQueue = {
    isEnabled: async () => { throw new Error('flag transport unavailable'); },
  };
  deps.queue.persistFile = async () => { persisted = true; return '/tmp/bullmq-source'; };
  deps.queue.enqueue = async () => { queued = true; return { queue_job_id: 'bullmq-fallback-1' }; };

  const result = await new KnowledgeUploadService(deps).admit(request());

  assert.equal(result.ok, true);
  assert.equal(persisted, true);
  assert.equal(queued, true);
  assert.equal(deps.created[0].orchestrationMode, 'bullmq');
});

test('evidence mode persists through the durable job and queue metadata', async () => {
  const deps = dependencies();
  let queued;
  deps.queue.enqueue = async (input) => { queued = input; return { queue_job_id: 'queue-1' }; };
  const req = request();
  req.metadata = { ingest_mode: 'evidence' };
  const result = await new KnowledgeUploadService(deps).admit(req);
  assert.equal(result.ok, true);
  assert.equal(deps.created[0].ingestMode, 'evidence');
  assert.equal(deps.created[0].metadata.ingest_mode, 'evidence');
  assert.equal(queued.metadata.ingest_mode, 'evidence');
});

test('an active upload cannot be force-mutated from evidence to both', async () => {
  const duplicate = {
    id: ids.job, userId: ids.user, status: 'processing', processingVersion: 1,
    ingestMode: 'evidence', metadata: { ingest_mode: 'evidence' },
  };
  const deps = dependencies({ duplicate });
  let queued = false;
  deps.queue.enqueue = async () => { queued = true; return { queue_job_id: 'queue-1' }; };
  const req = request();
  req.metadata = { ingest_mode: 'both' };

  const result = await new KnowledgeUploadService(deps).admit({ ...req, force: true });

  assert.equal(result.status, 409);
  assert.equal(result.body.code, 'INGEST_MODE_MISMATCH');
  assert.equal(result.body.requested_ingest_mode, 'both');
  assert.equal(result.body.actual_ingest_mode, 'evidence');
  assert.equal(deps.updates.length, 0);
  assert.equal(queued, false);
});

test('request metadata is sanitized before durable job creation and queue dispatch', async () => {
  const deps = dependencies();
  let queued;
  deps.queue.enqueue = async (input) => { queued = input; return { queue_job_id: 'queue-1' }; };
  const req = request();
  req.metadata = { ingest_mode: 'evidence', source: { citation: 'part\u0000one' }, values: ['a\u0000b'] };

  const result = await new KnowledgeUploadService(deps).admit(req);

  assert.equal(result.ok, true);
  assert.equal(deps.created[0].metadata.source.citation, 'partone');
  assert.deepEqual(deps.created[0].metadata.values, ['ab']);
  assert.equal(queued.metadata.source.citation, 'partone');
  assert.deepEqual(queued.metadata.values, ['ab']);
});

test('image uploads reject evidence mode before authorization or enqueue', async () => {
  const deps = dependencies();
  const req = request();
  req.file = {
    filename: 'diagram.png', contentType: 'image/png',
    data: Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(64, 1)]),
  };
  req.metadata = { ingest_mode: 'evidence' };
  const result = await new KnowledgeUploadService(deps).admit(req);
  assert.equal(result.status, 400);
  assert.equal(result.body.error, 'evidence_mode_unsupported_for_image');
  assert.equal(deps.created.length, 0);
});

test('page quota rejection keeps limits intact and returns the canonical contract', async () => {
  const deps = dependencies();
  deps.planEnforcer = { checkLimit: async () => ({
    allowed: false, reason: 'Monthly KB pages limit exceeded', limit: 20, current: 19, plan: 'free',
  }) };
  const result = await new KnowledgeUploadService(deps).admit(request());
  assert.equal(result.status, 402);
  assert.deepEqual(result.body, {
    error: 'plan_limit_exceeded', code: 'plan_limit_exceeded', message: 'Monthly KB pages limit exceeded',
    resource: 'kbPages', plan: 'free', limit: 20, current: 19, remaining: null,
    suggested_plan: 'pro', upgrade_url: '/hivemind/app/billing', metric: 'kbPages', current_usage: 19,
    remaining_capacity: null, estimated_pages: 1, ingest_mode: 'both',
  });
  assert.equal(deps.created.length, 0);
});

test('concurrent same-user admission reuses the durable winner without enqueueing or reserving credits', async () => {
  const deps = dependencies();
  const winner = { id: ids.job, userId: ids.user, status: 'queued', processingVersion: 1 };
  deps.jobStore.createOrReuse = async () => ({ job: winner, created: false });
  let queued = false;
  deps.queue.enqueue = async () => { queued = true; return { queue_job_id: 'queue-1' }; };
  const result = await new KnowledgeUploadService(deps).admit(request());
  assert.equal(result.ok, true);
  assert.equal(result.existing, true);
  assert.equal(result.job, winner);
  assert.equal(queued, false);
});

test('credit exhaustion returns the canonical quota contract without changing the configured credit limit', async () => {
  const deps = dependencies();
  deps.creditService = {
    reserve: async () => ({
      admitted: false,
      check: { reason: 'Monthly credits exhausted', limit: 100, current: 100, remaining: 0, plan: 'pro' },
    }),
  };
  const result = await new KnowledgeUploadService(deps).admit(request());
  assert.equal(result.status, 402);
  assert.deepEqual(result.body, {
    error: 'credits_exhausted', code: 'credits_exhausted', message: 'Monthly credits exhausted',
    resource: 'credits', plan: 'pro', limit: 100, current: 100, remaining: 0,
    suggested_plan: 'scale', upgrade_url: '/hivemind/app/billing', metric: 'credits', current_usage: 100,
    remaining_capacity: 0, estimated_pages: 1, ingest_mode: 'both',
  });
  assert.equal(deps.created.length, 1);
});

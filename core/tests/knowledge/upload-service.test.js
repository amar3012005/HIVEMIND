import test from 'node:test';
import assert from 'node:assert/strict';
import { KnowledgeUploadService } from '../../src/knowledge/upload-service.js';

const ids = {
  user: '11111111-1111-4111-8111-111111111111',
  org: '22222222-2222-4222-8222-222222222222',
  job: '33333333-3333-4333-8333-333333333333',
};

function dependencies({ storageMode = 'hybrid', ready = true, duplicate = null } = {}) {
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
    updateOwned: async (...args) => { updates.push(args); return { count: 1 }; }, fail: async () => {},
  };
  const queue = {
    isAvailable: async () => true, persistFile: () => '/tmp/file',
    enqueue: async () => ({ queue_job_id: 'queue-1' }),
  };
  return { prisma, jobStore, queue, created, updates, storageReady: () => ready };
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

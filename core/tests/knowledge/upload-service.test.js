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
  const prisma = {
    userOrganization: { findFirst: async () => ({ role: 'admin', roles: [] }) },
    team: { findFirst: async () => null }, project: { findMany: async () => [] },
    organization: { findFirst: async () => ({ memoryStorageMode: storageMode }) },
  };
  const jobStore = {
    findDuplicate: async () => duplicate,
    findOwned: async () => created.at(-1) || duplicate,
    create: async (data) => { const job = { id: ids.job, ...data, memoryIds: [], createdAt: new Date(), updatedAt: new Date() }; created.push(job); return job; },
    updateOwned: async () => ({ count: 1 }), fail: async () => {},
  };
  const queue = {
    isAvailable: async () => true, persistFile: () => '/tmp/file',
    enqueue: async () => ({ queue_job_id: 'queue-1' }),
  };
  return { prisma, jobStore, queue, created, storageReady: () => ready };
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

test('accepted upload persists one durable job before enqueue', async () => {
  const deps = dependencies();
  const result = await new KnowledgeUploadService(deps).admit(request());
  assert.equal(result.ok, true);
  assert.equal(deps.created.length, 1);
  assert.equal(deps.created[0].orgId, ids.org);
  assert.equal(deps.created[0].userId, ids.user);
  assert.equal(deps.created[0].scopeKey, `personal:${ids.user}`);
});

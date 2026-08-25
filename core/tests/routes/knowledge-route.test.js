import test from 'node:test';
import assert from 'node:assert/strict';
import { handleKnowledgeUploadRoute } from '../../src/routes/knowledge.js';
import { planLimitBody } from '../../src/billing/limit-response.js';

function context(overrides = {}) {
  const res = { headers: {}, setHeader(name, value) { this.headers[name] = value; } };
  return {
    req: { headers: { 'content-type': 'multipart/form-data; boundary=abc' } }, res,
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    readBoundedBuffer: async () => Buffer.from('multipart'), MULTIPART_MAX_BYTES: 1024,
    parseMultipart: () => [{ name: 'file', filename: 'report.pdf', contentType: 'application/pdf', data: Buffer.from('valid pdf payload with enough content') }],
    normalizeScopeIds: (values) => values.filter(Boolean),
    jsonResponse: (_res, body, statusCode = 200) => ({ body, statusCode }),
    knowledgeUploadService: { admit: async () => ({ ok: true, job: {
      id: '33333333-3333-4333-8333-333333333333', status: 'queued', stage: 'queued', progress: 0,
      storageMode: 'hybrid', memoryIds: [], createdAt: new Date(), updatedAt: new Date(),
    } }) },
    ...overrides,
  };
}

function multipartWith(fields = {}) {
  return Object.entries(fields).map(([name, value]) => ({ name, value }));
}

test('canonical upload returns a normalized durable 202', async () => {
  const result = await handleKnowledgeUploadRoute(context());
  assert.equal(result.statusCode, 202);
  assert.equal(result.body.job_id, '33333333-3333-4333-8333-333333333333');
  assert.equal(result.body.storage_mode, 'hybrid');
});

test('canonical upload fails closed when durable service is unavailable', async () => {
  const result = await handleKnowledgeUploadRoute(context({ knowledgeUploadService: null }));
  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error, 'canonical_ingest_unavailable');
});

test('canonical upload does not reveal rejected scope details', async () => {
  const result = await handleKnowledgeUploadRoute(context({ knowledgeUploadService: {
    admit: async () => ({ ok: false, status: 404, body: { error: 'scope_not_found' } }),
  } }));
  assert.equal(result.statusCode, 404);
  assert.deepEqual(result.body, { error: 'scope_not_found' });
});

test('canonical upload defaults missing ingestMode to both', async () => {
  let admitted;
  const ctx = context({ knowledgeUploadService: {
    admit: async (input) => {
      admitted = input;
      return { ok: true, job: {
        id: '33333333-3333-4333-8333-333333333333', status: 'queued', stage: 'queued', progress: 0,
        ingestMode: input.metadata.ingest_mode, storageMode: 'hybrid', memoryIds: [],
        createdAt: new Date(), updatedAt: new Date(),
      } };
    },
  } });
  await handleKnowledgeUploadRoute(ctx);
  assert.equal(admitted.metadata.ingest_mode, 'both');
  assert.equal(admitted.ingestMode, 'both');
});

test('canonical upload accepts evidence and rejects unknown ingest modes', async () => {
  let admitted;
  const service = { admit: async (input) => {
    admitted = input;
    return { ok: true, job: {
      id: '33333333-3333-4333-8333-333333333333', status: 'queued', stage: 'queued', progress: 0,
      ingestMode: input.metadata.ingest_mode, storageMode: 'hybrid', memoryIds: [],
      createdAt: new Date(), updatedAt: new Date(),
    } };
  } };
  const evidence = context({
    parseMultipart: () => [
      { name: 'file', filename: 'report.pdf', contentType: 'application/pdf', data: Buffer.from('valid pdf payload with enough content') },
      ...multipartWith({ ingestMode: 'evidence' }),
    ],
    knowledgeUploadService: service,
  });
  const accepted = await handleKnowledgeUploadRoute(evidence);
  assert.equal(accepted.statusCode, 202);
  assert.equal(admitted.metadata.ingest_mode, 'evidence');
  assert.equal(admitted.ingestMode, 'evidence');

  const invalid = context({
    parseMultipart: () => [
      { name: 'file', filename: 'report.pdf', contentType: 'application/pdf', data: Buffer.from('valid pdf payload with enough content') },
      ...multipartWith({ ingestMode: 'vector-only' }),
    ],
    knowledgeUploadService: service,
  });
  const rejected = await handleKnowledgeUploadRoute(invalid);
  assert.equal(rejected.statusCode, 400);
  assert.equal(rejected.body.error, 'invalid_ingest_mode');
});

test('canonical upload forwards explicit force to the durable reprocess state machine', async () => {
  let admitted;
  const result = await handleKnowledgeUploadRoute(context({
    parseMultipart: () => [
      { name: 'file', filename: 'report.pdf', contentType: 'application/pdf', data: Buffer.from('valid pdf payload with enough content') },
      ...multipartWith({ ingestMode: 'both', force: 'true' }),
    ],
    knowledgeUploadService: { admit: async (input) => {
      admitted = input;
      return { ok: true, job: {
        id: '33333333-3333-4333-8333-333333333333', status: 'queued', stage: 'queued', progress: 0,
        ingestMode: 'both', storageMode: 'hybrid', memoryIds: [], createdAt: new Date(), updatedAt: new Date(),
      } };
    } },
  }));
  assert.equal(result.statusCode, 202);
  assert.equal(admitted.force, true);
});

test('canonical upload fails closed when the durable job returns a different mode', async () => {
  const failures = [];
  const result = await handleKnowledgeUploadRoute(context({
    parseMultipart: () => [
      { name: 'file', filename: 'report.pdf', contentType: 'application/pdf', data: Buffer.from('valid pdf payload with enough content') },
      ...multipartWith({ ingestMode: 'both' }),
    ],
    knowledgeUploadService: {
      admit: async () => ({ ok: true, existing: false, job: {
        id: '33333333-3333-4333-8333-333333333333', status: 'queued', stage: 'queued', progress: 0,
        ingestMode: 'evidence', storageMode: 'hybrid', memoryIds: [], createdAt: new Date(), updatedAt: new Date(),
      } }),
      jobStore: { fail: async (...args) => failures.push(args) },
    },
  }));
  assert.equal(result.statusCode, 409);
  assert.equal(result.body.code, 'INGEST_MODE_MISMATCH');
  assert.equal(result.body.requested_ingest_mode, 'both');
  assert.equal(result.body.actual_ingest_mode, 'evidence');
  assert.equal(failures.length, 1);
});

test('credit preflight returns usage, capacity, estimate, plan, and immutable mode', async () => {
  let admitted = false;
  const result = await handleKnowledgeUploadRoute(context({
    creditService: { getSummary: async () => ({ unlimited: false, remaining: 0, plan: 'free', included: 100, used: 100, reserved: 0 }) },
    planLimitBody,
    knowledgeUploadService: {
      estimatePages: async () => 3,
      admit: async () => { admitted = true; return { ok: true }; },
    },
  }));
  assert.equal(result.statusCode, 402);
  assert.equal(result.body.metric, 'credits');
  assert.equal(result.body.current_usage, 100);
  assert.equal(result.body.limit, 100);
  assert.equal(result.body.remaining_capacity, 0);
  assert.equal(result.body.estimated_pages, 3);
  assert.equal(result.body.plan, 'free');
  assert.equal(result.body.ingest_mode, 'both');
  assert.equal(admitted, false);
});

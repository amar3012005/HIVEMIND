import test from 'node:test';
import assert from 'node:assert/strict';
import { handleKnowledgeUploadRoute } from '../../src/routes/knowledge.js';

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

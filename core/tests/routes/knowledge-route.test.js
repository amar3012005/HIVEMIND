import test from 'node:test';
import assert from 'node:assert/strict';
import { handleKnowledgeUploadRoute } from '../../src/routes/knowledge.js';

function makeCtx(overrides = {}) {
  const headers = {};
  const res = {
    headers,
    setHeader(name, value) {
      headers[name] = value;
    },
  };
  const jsonResponse = (_res, body, statusCode = 200) => ({ statusCode, body });
  return {
    req: { headers: { 'content-type': 'multipart/form-data; boundary=abc' } },
    res,
    url: new URL('http://localhost/api/knowledge/upload'),
    userId: 'user-1',
    orgId: 'org-1',
    prisma: {
      userOrganization: {
        findUnique: async () => ({ role: 'owner' }),
      },
      knowledgeDocument: {
        findFirst: async () => null,
      },
      project: {
        findFirst: async () => null,
      },
    },
    persistentMemoryEngine: {},
    documentFirstIngestion: {
      ingestSource: async () => {
        throw new Error('ingestSource should not run in this test');
      },
    },
    planEnforcer: null,
    planLimitBody: () => ({}),
    readBoundedBuffer: async () => Buffer.from('ignored'),
    MULTIPART_MAX_BYTES: 1024,
    parseMultipart: () => [
      {
        name: 'file',
        filename: 'report.pdf',
        contentType: 'application/pdf',
        data: Buffer.from('pdf-bytes'),
      },
    ],
    normalizeScopeIds: (values) => values.filter(Boolean),
    buildAccessContext: async () => ({ projectIds: [] }),
    jsonResponse,
    kbIngestQueue: {
      isEnabledFor: () => true,
      persistFile: () => '/tmp/report.pdf',
      enqueue: async () => ({ job_id: 'kbq_123', backpressure: false }),
    },
    ingestTracker: {
      createJob() {},
      getJob() { return null; },
      updateJob() {},
    },
    buildRoutedIngestPayloads: async (payload) => [payload],
    smartIngestRouter: null,
    persistentMemoryStore: null,
    qdrantClient: null,
    getQdrantClient: null,
    recallPersistedMemories: null,
    ...overrides,
  };
}

test('knowledge upload route returns 202 with durable queue in production', async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const result = await handleKnowledgeUploadRoute(makeCtx());
    assert.equal(result.statusCode, 202);
    assert.equal(result.body.status, 'queued');
    assert.equal(result.body.mode, 'queued');
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});

test('knowledge upload route fails closed with 503 when queue is unavailable in production', async () => {
  const prevNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  let ingestRan = false;
  try {
    const result = await handleKnowledgeUploadRoute(makeCtx({
      documentFirstIngestion: {
        ingestSource: async () => {
          ingestRan = true;
          return {};
        },
      },
      kbIngestQueue: {
        isEnabledFor: () => false,
      },
    }));
    assert.equal(result.statusCode, 503);
    assert.equal(result.body.error, 'queue_unavailable');
    assert.equal(ingestRan, false);
  } finally {
    if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prevNodeEnv;
  }
});

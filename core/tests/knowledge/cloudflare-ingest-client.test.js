import test from 'node:test';
import assert from 'node:assert/strict';
import { CloudflareKnowledgeIngestClient } from '../../src/knowledge/cloudflare-ingest-client.js';

const ORG_ID = '22222222-2222-4222-8222-222222222222';
const JOB_ID = '33333333-3333-4333-8333-333333333333';
const USER_ID = '44444444-4444-4444-8444-444444444444';

async function withWorkflowEnv(fn) {
  const names = [
    'HIVEMIND_LOCAL_MODE', 'KNOWLEDGE_INGEST_WORKFLOW_ENVIRONMENT', 'NODE_ENV',
    'KNOWLEDGE_INGEST_WORKFLOW_URL', 'KNOWLEDGE_INGEST_WORKFLOW_SECRET',
    'KNOWLEDGE_INGEST_SOURCE_UPLOAD_ATTEMPTS', 'KNOWLEDGE_INGEST_SOURCE_UPLOAD_TIMEOUT_MS',
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  Object.assign(process.env, {
    HIVEMIND_LOCAL_MODE: 'true', KNOWLEDGE_INGEST_WORKFLOW_ENVIRONMENT: 'local',
    KNOWLEDGE_INGEST_WORKFLOW_URL: 'http://127.0.0.1:8788',
    KNOWLEDGE_INGEST_WORKFLOW_SECRET: 'local-test-secret',
  });
  try { return await fn(); } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
}

test('local Flagship decision gates durable source storage and identifier-only admission', async () => {
  await withWorkflowEnv(async () => {
    const calls = [];
    const client = new CloudflareKnowledgeIngestClient({
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        if (url.includes('/enabled?')) return Response.json({ enabled: true });
        if (url.includes('/objects/')) return Response.json({ key: 'org/object', etag: 'etag-1' });
        return Response.json({ instance_id: `kb-${JOB_ID}-v7` });
      },
    });

    assert.equal(await client.isEnabled(ORG_ID, USER_ID), true);
    assert.match(calls.at(-1).url, new RegExp(`user_id=${USER_ID}`));
    assert.deepEqual(await client.persistFile({
      orgId: ORG_ID, checksum: 'a'.repeat(64), filename: '../résumé.pdf', fileBuffer: Buffer.from('%PDF'),
    }), { objectKey: 'org/object', etag: 'etag-1' });
    await client.enqueue({ userId: USER_ID, orgId: ORG_ID, trackerJobId: JOB_ID, processingVersion: 7 });

    const admission = JSON.parse(calls.at(-1).init.body);
    assert.deepEqual(admission, { job_id: JOB_ID, org_id: ORG_ID, user_id: USER_ID, processing_version: 7, admitted: true });
    assert.equal(Object.hasOwn(admission, 'file'), false);
    assert.equal(Object.hasOwn(admission, 'metadata'), false);
    assert.equal(calls.every((call) => call.init.headers.authorization === 'Bearer local-test-secret'), true);
  });
});

test('Flagship transport errors remain visible to the upload admission fallback', async () => {
  await withWorkflowEnv(async () => {
    const client = new CloudflareKnowledgeIngestClient({
      fetchImpl: async () => { throw new Error('flag service unavailable'); },
      logger: { warn() {} },
    });
    await assert.rejects(client.isEnabled(ORG_ID, USER_ID), /flag service unavailable/);
  });
});

test('Flagship selection fails closed when either tenant identity is missing', async () => {
  await withWorkflowEnv(async () => {
    let calls = 0;
    const client = new CloudflareKnowledgeIngestClient({
      fetchImpl: async () => { calls += 1; return Response.json({ enabled: true }); },
    });
    assert.equal(await client.isEnabled(ORG_ID), false);
    assert.equal(await client.isEnabled(null, USER_ID), false);
    assert.equal(calls, 0);
  });
});

test('the client is configured by its authenticated endpoint rather than host feature booleans', async () => {
  await withWorkflowEnv(async () => {
    const client = new CloudflareKnowledgeIngestClient({ fetchImpl: async () => Response.json({ enabled: true }) });
    assert.equal(client.configured(), true);
    delete process.env.KNOWLEDGE_INGEST_WORKFLOW_SECRET;
    assert.equal(client.configured(), false);
  });
});

test('production mode requires an authenticated endpoint and leaves enablement to Flagship', async () => {
  await withWorkflowEnv(async () => {
    const client = new CloudflareKnowledgeIngestClient({ fetchImpl: async () => Response.json({ enabled: true }) });
    Object.assign(process.env, {
      HIVEMIND_LOCAL_MODE: 'false', NODE_ENV: 'production',
      KNOWLEDGE_INGEST_WORKFLOW_ENVIRONMENT: 'production',
    });
    assert.equal(client.configured(), true);
    assert.equal(await client.isEnabled(ORG_ID, USER_ID), true);
  });
});

test('R2 reads reject an object whose ETag changed after admission', async () => {
  await withWorkflowEnv(async () => {
    const client = new CloudflareKnowledgeIngestClient({
      fetchImpl: async () => new Response('changed bytes', {
        status: 200,
        headers: { etag: 'new-etag' },
      }),
    });
    await assert.rejects(
      () => client.getObject('org/object', { expectedEtag: 'admitted-etag' }),
      (error) => error.code === 'SOURCE_OBJECT_INTEGRITY_FAILED' && error.retryable === false,
    );
  });
});

test('R2 source admission retries an idempotent object key after a transient timeout', async () => {
  await withWorkflowEnv(async () => {
    process.env.KNOWLEDGE_INGEST_SOURCE_UPLOAD_ATTEMPTS = '2';
    process.env.KNOWLEDGE_INGEST_SOURCE_UPLOAD_TIMEOUT_MS = '30000';
    let attempts = 0;
    const client = new CloudflareKnowledgeIngestClient({
      fetchImpl: async () => {
        attempts += 1;
        if (attempts === 1) throw Object.assign(new Error('timed out'), { code: 23 });
        return Response.json({ key: 'org/recovered', etag: 'etag-recovered' });
      },
    });
    const persisted = await client.persistFile({
      orgId: ORG_ID, checksum: 'b'.repeat(64), filename: 'large.pdf', fileBuffer: Buffer.from('%PDF'),
    });
    assert.equal(attempts, 2);
    assert.deepEqual(persisted, { objectKey: 'org/recovered', etag: 'etag-recovered' });
  });
});

test('Workflow status preserves structured state and distinguishes missing from outage', async () => {
  await withWorkflowEnv(async () => {
    const running = new CloudflareKnowledgeIngestClient({
      fetchImpl: async () => Response.json({ status: 'running' }),
    });
    assert.deepEqual(await running.getWorkflowStatus('wf-running'), { status: 'running' });

    const missing = new CloudflareKnowledgeIngestClient({
      fetchImpl: async () => new Response('', { status: 404 }),
    });
    assert.deepEqual(await missing.getWorkflowStatus('wf-missing'), { status: 'missing' });

    const outage = new CloudflareKnowledgeIngestClient({
      fetchImpl: async () => new Response('', { status: 503 }),
    });
    await assert.rejects(
      () => outage.getWorkflowStatus('wf-unknown'),
      (error) => error.code === 'WORKFLOW_STATUS_UNAVAILABLE' && error.retryable === true,
    );
  });
});

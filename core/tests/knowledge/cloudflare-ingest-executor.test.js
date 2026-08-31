import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import {
  CloudflareKnowledgeIngestExecutor,
  isRetryableMaterializationError,
  isAuthorizedKnowledgeWorkflowRequest,
} from '../../src/knowledge/cloudflare-ingest-executor.js';

const ids = {
  job: '33333333-3333-4333-8333-333333333333',
  org: '22222222-2222-4222-8222-222222222222',
  user: '11111111-1111-4111-8111-111111111111',
  document: '44444444-4444-4444-8444-444444444444',
};

function stepStore() {
  const rows = new Map();
  const key = ({ jobId, processingVersion, stageKey, shardKey = 'root' }) => `${jobId}:${processingVersion}:${stageKey}:${shardKey}`;
  return {
    rows,
    async get(identity) { return rows.get(key(identity)) || null; },
    async run(identity, work) {
      const mapKey = key(identity);
      const existing = rows.get(mapKey);
      if (existing?.status === 'succeeded') return { reused: true, receipt: existing };
      const output = await work();
      const receipt = {
        id: `receipt-${rows.size + 1}`, status: 'succeeded',
        outputRefs: output.outputRefs || output, coverage: output.coverage || {},
      };
      rows.set(mapKey, receipt);
      return { reused: false, receipt };
    },
  };
}

function fixture({ remote = false, image = false } = {}) {
  const bytes = Buffer.from('%PDF-1.7\ncanonical');
  const job = {
    id: ids.job, orgId: ids.org, userId: ids.user, processingVersion: 3,
    orchestrationMode: 'cloudflare_workflow', status: 'processing', scopeKey: `personal:${ids.user}`,
    storageMode: remote ? 'byod_amr' : 'hybrid', sourceObjectKey: `org/${ids.org}/source`,
    sourceObjectEtag: 'etag-at-admission',
    checksum: crypto.createHash('sha256').update(bytes).digest('hex'), filename: image ? 'photo.jpg' : 'report.pdf',
    contentType: image ? 'image/jpeg' : 'application/pdf', mediaKind: image ? 'image' : 'document',
    ingestMode: 'both', metadata: { ingest_mode: 'both' },
  };
  const events = [];
  const steps = stepStore();
  const executor = new CloudflareKnowledgeIngestExecutor({
    prisma: {
      knowledgeDocument: {
        findFirst: async () => ({ id: ids.document, _count: { segments: 8, memoryLinks: 2 } }),
      },
      memory: { findFirst: async () => ({ id: ids.document }) },
    },
    jobStore: {
      findOwned: async () => job,
      progress: async (...args) => { events.push(['progress', ...args]); },
      complete: async (...args) => { events.push(['complete', ...args]); return true; },
      fail: async (...args) => { events.push(['fail', ...args]); },
    },
    objectClient: {
      getObject: async (key, options) => { events.push(['get', key, options]); return bytes; },
      deleteObject: async (key) => { events.push(['delete', key]); },
    },
    documentFirstIngestion: {
      promoteStoredEvidence: async ({ documentId, onProgress }) => {
        events.push(['promote', documentId]);
        onProgress({ stage: 'promoting', progress: 80 });
        return {
          documentId, promotedMemoryIds: ['memory-1', 'memory-2'], pages: 4,
          segmentCount: 8, candidateCount: 3, promotedCount: 2,
          coverage: { candidates: 3, promoted: 2 },
        };
      },
    },
    validateJob: async () => { events.push(['validate']); },
    processUpload: async ({ onProgress, metadata, stageHooks }) => {
      if (stageHooks?.beforeEvidenceEmbedding) {
        events.push(['extract-complete']);
        await stageHooks.beforeEvidenceEmbedding({ documentId: ids.document, segmentCount: 8 });
        events.push(['embed-start']);
      }
      onProgress({ stage: 'embedding', progress: 65 });
      if (image) {
        events.push(['image-metadata', metadata]);
        return {
          documentId: ids.document, promotedMemoryIds: [ids.document], pages: 1,
          segmentCount: 0, candidateCount: 1, promotedCount: 1,
          coverage: { memory: 1, vector: 1, entities: 2, claims: 1 },
        };
      }
      return {
        documentId: ids.document, promotedMemoryIds: ['memory-1', 'memory-2'],
        pages: 4, segmentCount: 8, candidateCount: 3, promotedCount: 2,
        coverage: { total: 8, succeeded: 8, healed: 0, failed: 0 },
      };
    },
    isRemoteOrg: async () => remote,
    stepStore: steps,
  });
  return { executor, events, steps, job };
}

test('the Workflow executor verifies bytes, evidence coverage, persistence and terminal settlement', async () => {
  const { executor, events } = fixture();
  const input = { jobId: ids.job, orgId: ids.org, userId: ids.user, processingVersion: 3 };
  await executor.execute({ ...input, stage: 'acquire' });
  await executor.execute({ ...input, stage: 'materialize' });
  await executor.execute({ ...input, stage: 'reconcile' });

  assert.equal(events.filter(([kind]) => kind === 'complete').length, 1);
  assert.deepEqual(events.find(([kind]) => kind === 'get').slice(1), [
    `org/${ids.org}/source`, { expectedEtag: 'etag-at-admission' },
  ]);
  assert.deepEqual(events.find(([kind]) => kind === 'delete').slice(1), [`org/${ids.org}/source`]);
});

test('materialization records real evidence and promotion checkpoints', async () => {
  const { executor, steps, events } = fixture();
  const input = { jobId: ids.job, orgId: ids.org, userId: ids.user, processingVersion: 3 };
  await executor.execute({ ...input, stage: 'materialize' });
  assert.deepEqual(
    [...steps.rows.keys()].map((key) => key.split(':').at(-2)).sort(),
    ['materialize', 'materialize_evidence', 'promote_memories'].sort(),
  );
  assert.equal(events.filter(([kind]) => kind === 'get').length, 1);
  assert.equal(events.filter(([kind]) => kind === 'promote').length, 1);
  assert.ok(events.findIndex(([kind]) => kind === 'extract-complete')
    < events.findIndex(([kind]) => kind === 'embed-start'));
});

test('documents hand off extract capacity before embedding and use independent stage pools', async () => {
  const { executor, events } = fixture();
  const claims = [];
  const releases = [];
  executor._waitForProcessingLease = async (_job, stage) => { claims.push(stage); return { acquired: true }; };
  executor._releaseProcessingLease = async (_job, stage) => { releases.push(stage || 'all'); };

  await executor.execute({
    jobId: ids.job, orgId: ids.org, userId: ids.user, processingVersion: 3, stage: 'materialize',
  });

  assert.deepEqual(claims, ['extract', 'embed', 'promote']);
  assert.equal(releases.indexOf('extract') < releases.indexOf('embed'), true);
  assert.equal(events.some(([kind]) => kind === 'promote'), true);
});

test('duplicate Workflow stage delivery reuses its durable receipt and settles only once', async () => {
  const { executor, events } = fixture();
  const input = { jobId: ids.job, orgId: ids.org, userId: ids.user, processingVersion: 3 };
  await executor.execute({ ...input, stage: 'materialize' });
  const replay = await executor.execute({ ...input, stage: 'materialize' });
  await executor.execute({ ...input, stage: 'reconcile' });
  const replaySettlement = await executor.execute({ ...input, stage: 'reconcile' });

  assert.equal(replay.reused, true);
  assert.equal(replaySettlement.reused, true);
  assert.equal(events.filter(([kind]) => kind === 'complete').length, 1);
});

test('remote storage reconciliation does not require a central document row', async () => {
  const { executor } = fixture({ remote: true });
  executor.prisma.knowledgeDocument.findFirst = async () => { throw new Error('central lookup must not run'); };
  const input = { jobId: ids.job, orgId: ids.org, userId: ids.user, processingVersion: 3 };
  await executor.execute({ ...input, stage: 'materialize' });
  await assert.doesNotReject(() => executor.execute({ ...input, stage: 'reconcile' }));
});

test('image jobs use authoritative mediaKind and settle one canonical memory without document evidence', async () => {
  const { executor, events, steps } = fixture({ image: true });
  executor.prisma.knowledgeDocument.findFirst = async () => { throw new Error('image must not reconcile as a document'); };
  const input = { jobId: ids.job, orgId: ids.org, userId: ids.user, processingVersion: 3 };
  await executor.execute({ ...input, stage: 'materialize' });
  await executor.execute({ ...input, stage: 'reconcile' });

  assert.equal(events.filter(([kind]) => kind === 'promote').length, 0);
  assert.equal(events.filter(([kind]) => kind === 'complete').length, 1);
  assert.equal(events.find(([kind]) => kind === 'image-metadata')[1].media_kind, 'image');
  assert.deepEqual(
    [...steps.rows.keys()].map((key) => key.split(':').at(-2)).sort(),
    ['materialize', 'materialize_image', 'reconcile'].sort(),
  );
});

test('deterministic media and signature errors cannot enter an infinite redispatch loop', () => {
  assert.equal(isRetryableMaterializationError('IMAGE_NOT_A_DOCUMENT'), false);
  assert.equal(isRetryableMaterializationError('FILE_SIGNATURE_MISMATCH'), false);
  assert.equal(isRetryableMaterializationError('PARTIAL_EMBEDDING'), true);
});

test('materialization dispatch returns immediately and exposes a durable polling receipt', async () => {
  const { executor, steps } = fixture();
  const input = { jobId: ids.job, orgId: ids.org, userId: ids.user, processingVersion: 3 };
  const dispatched = await executor.startMaterialize(input);
  assert.equal(dispatched.accepted, true);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const status = await executor.materializeStatus(input);
    if (status.status === 'succeeded') {
      assert.equal(status.result.documentId, ids.document);
      assert.equal([...steps.rows.values()].filter((row) => row.status === 'succeeded').length >= 3, true);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('background materialization did not complete');
});

test('internal Workflow authorization requires an explicit environment gate and exact secret', () => {
  const previous = {
    local: process.env.HIVEMIND_LOCAL_MODE,
    enabled: process.env.KNOWLEDGE_INGEST_WORKFLOW_ENABLED,
    secret: process.env.KNOWLEDGE_INGEST_WORKFLOW_SECRET,
    environment: process.env.KNOWLEDGE_INGEST_WORKFLOW_ENVIRONMENT,
    acknowledgement: process.env.KNOWLEDGE_INGEST_PRODUCTION_ACK,
    nodeEnv: process.env.NODE_ENV,
  };
  try {
    Object.assign(process.env, {
      HIVEMIND_LOCAL_MODE: 'true', KNOWLEDGE_INGEST_WORKFLOW_ENABLED: 'true',
      KNOWLEDGE_INGEST_WORKFLOW_SECRET: 'expected-secret',
    });
    assert.equal(isAuthorizedKnowledgeWorkflowRequest({ headers: { authorization: 'Bearer expected-secret' } }), true);
    assert.equal(isAuthorizedKnowledgeWorkflowRequest({ headers: { authorization: 'Bearer wrong' } }), false);
    process.env.HIVEMIND_LOCAL_MODE = 'false';
    assert.equal(isAuthorizedKnowledgeWorkflowRequest({ headers: { authorization: 'Bearer expected-secret' } }), false);
    Object.assign(process.env, {
      NODE_ENV: 'production', KNOWLEDGE_INGEST_WORKFLOW_ENVIRONMENT: 'production',
      KNOWLEDGE_INGEST_PRODUCTION_ACK: 'enable-cloudflare-workflow-v1',
    });
    assert.equal(isAuthorizedKnowledgeWorkflowRequest({ headers: { authorization: 'Bearer expected-secret' } }), true);
  } finally {
    if (previous.local === undefined) delete process.env.HIVEMIND_LOCAL_MODE; else process.env.HIVEMIND_LOCAL_MODE = previous.local;
    if (previous.enabled === undefined) delete process.env.KNOWLEDGE_INGEST_WORKFLOW_ENABLED; else process.env.KNOWLEDGE_INGEST_WORKFLOW_ENABLED = previous.enabled;
    if (previous.secret === undefined) delete process.env.KNOWLEDGE_INGEST_WORKFLOW_SECRET; else process.env.KNOWLEDGE_INGEST_WORKFLOW_SECRET = previous.secret;
    if (previous.environment === undefined) delete process.env.KNOWLEDGE_INGEST_WORKFLOW_ENVIRONMENT; else process.env.KNOWLEDGE_INGEST_WORKFLOW_ENVIRONMENT = previous.environment;
    if (previous.acknowledgement === undefined) delete process.env.KNOWLEDGE_INGEST_PRODUCTION_ACK; else process.env.KNOWLEDGE_INGEST_PRODUCTION_ACK = previous.acknowledgement;
    if (previous.nodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previous.nodeEnv;
  }
});

test('cancelled, stale, and cross-tenant deliveries cannot execute work', async () => {
  const { executor, events, job } = fixture();
  const base = { jobId: ids.job, orgId: ids.org, userId: ids.user, processingVersion: 3, stage: 'acquire' };
  job.status = 'cancelled';
  await assert.rejects(executor.execute(base), (error) => error.code === 'UPLOAD_CANCELLED');
  job.status = 'processing';
  await assert.rejects(
    executor.execute({ ...base, userId: '66666666-6666-4666-8666-666666666666' }),
    (error) => error.code === 'WORKFLOW_USER_MISMATCH',
  );
  await assert.rejects(
    executor.execute({ ...base, processingVersion: 2 }),
    (error) => error.code === 'STALE_WORKFLOW',
  );
  executor.jobStore.findOwned = async () => null;
  await assert.rejects(
    executor.execute({ ...base, orgId: '55555555-5555-4555-8555-555555555555' }),
    (error) => error.code === 'JOB_NOT_FOUND',
  );
  assert.equal(events.length, 0);
});

test('partial evidence coverage cannot reach settlement', async () => {
  const { executor, events } = fixture();
  executor.processUpload = async () => ({
    documentId: ids.document, promotedMemoryIds: [], pages: 2,
    segmentCount: 8, candidateCount: 0, promotedCount: 0,
    coverage: { evidence_embed: { total: 8, embedded: 7, failed: 1, healed: 0 } },
  });
  const base = { jobId: ids.job, orgId: ids.org, userId: ids.user, processingVersion: 3 };
  await assert.rejects(
    executor.execute({ ...base, stage: 'materialize' }),
    (error) => error.code === 'PARTIAL_EMBEDDING' && error.retryable === true,
  );
  assert.equal(events.some(([kind]) => kind === 'complete'), false);
});

test('the fenced scheduler admits four globally, caps each organization at two, and releases cleanly', async () => {
  const { executor, job } = fixture();
  const leases = [];
  executor.prisma.knowledgeIngestLease = {
    findMany: async () => leases.map((lease) => ({ ...lease })),
    create: async ({ data }) => { leases.push({ ...data }); return data; },
    update: async ({ where, data }) => {
      const index = leases.findIndex((lease) => lease.leaseKey === where.leaseKey);
      leases[index] = { ...leases[index], ...data };
      return leases[index];
    },
    deleteMany: async ({ where }) => {
      const before = leases.length;
      for (let index = leases.length - 1; index >= 0; index -= 1) {
        if (leases[index].jobId === where.jobId && leases[index].processingVersion === where.processingVersion) {
          leases.splice(index, 1);
        }
      }
      return { count: before - leases.length };
    },
  };
  const jobs = [
    job,
    { ...job, id: '77777777-7777-4777-8777-777777777777' },
    { ...job, id: '88888888-8888-4888-8888-888888888888' },
    { ...job, id: '99999999-9999-4999-8999-999999999999', orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
    { ...job, id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', orgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' },
  ];
  const claims = [];
  for (const candidate of jobs) claims.push(await executor._claimProcessingLease(candidate));
  assert.deepEqual(claims.map((claim) => claim.acquired), [true, true, false, true, true]);
  assert.equal(leases.length, 4);
  await executor._releaseProcessingLease(jobs[0]);
  assert.equal((await executor._claimProcessingLease(jobs[2])).acquired, true);
  assert.equal(leases.length, 4);
});

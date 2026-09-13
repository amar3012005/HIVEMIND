import assert from 'node:assert/strict';
import test from 'node:test';

import {
  KbIngestQueue,
  durableQueueJobId,
  isStoredEvidencePromotion,
  knowledgeIngestEvent,
  latchQueuedIngestMode,
  terminalIngestWarnings,
  requireCompleteEvidenceEmbedding,
  requireCompleteMemoryEmbedding,
} from '../../src/knowledge/kb-ingest-queue.js';

test('queue lifecycle events use the canonical knowledge.ingest namespace', () => {
  const event = JSON.parse(knowledgeIngestEvent('started', { job_id: 'job-1' }));
  assert.equal(event.event, 'knowledge.ingest.started');
  assert.equal(event.task, 'knowledge.ingest');
  assert.equal(event.job_id, 'job-1');
  assert.throws(() => knowledgeIngestEvent('progress'), /Unsupported knowledge ingest lifecycle phase/);
});

test('terminal completion exposes a sanitized warning when promotion fails after evidence persists', () => {
  const warnings = terminalIngestWarnings({
    warnings: [{ code: 'TABLES_SKIPPED', message: 'Table extraction was skipped.' }],
    promotion_failed: true,
    promotion_error: 'provider rejected API key sk-private-value',
  });
  const terminalEvent = JSON.parse(knowledgeIngestEvent('completed', { warnings }));

  assert.equal(terminalEvent.event, 'knowledge.ingest.completed');
  assert.deepEqual(terminalEvent.warnings, [
    { code: 'TABLES_SKIPPED', message: 'Table extraction was skipped.' },
    { code: 'MEMORY_PROMOTION_FAILED', message: 'Memory generation failed; evidence is ready.' },
  ]);
  assert.doesNotMatch(JSON.stringify(terminalEvent), /sk-private-value/);
});

test('durable BullMQ IDs never contain the forbidden colon separator', () => {
  const id = durableQueueJobId('378c5f62-8848-48bc-be28-4f8af4d1e2b5', 2);
  assert.equal(id, '378c5f62-8848-48bc-be28-4f8af4d1e2b5-v2');
  assert.equal(id.includes(':'), false);
});

test('BullMQ fallback availability is not controlled by legacy rollout environment flags', () => {
  const previous = process.env.KB_QUEUE_MODE;
  process.env.KB_QUEUE_MODE = 'off';
  try {
    const queue = Object.create(KbIngestQueue.prototype);
    queue.queue = { name: 'kb-ingest' };
    assert.equal(queue.isEnabledFor('org-canary'), true);
    queue.queue = null;
    assert.equal(queue.isEnabledFor('org-canary'), false);
  } finally {
    if (previous === undefined) delete process.env.KB_QUEUE_MODE;
    else process.env.KB_QUEUE_MODE = previous;
  }
});

test('stored-evidence promotion is selected only with an explicit durable document id', () => {
  assert.equal(isStoredEvidencePromotion({ promotion_existing_evidence: true, promotion_document_id: 'doc-1' }), true);
  assert.equal(isStoredEvidencePromotion({ promotion_existing_evidence: true }), false);
  assert.equal(isStoredEvidencePromotion({ promotion_document_id: 'doc-1' }), false);
});

test('worker only accepts the immutable mode persisted on the durable upload job', () => {
  assert.deepEqual(latchQueuedIngestMode({ durableMode: 'both', queuedMode: 'both' }), { ok: true, value: 'both' });
  assert.deepEqual(latchQueuedIngestMode({ durableMode: 'evidence', queuedMode: 'both' }), {
    ok: false, expected: 'evidence', actual: 'both',
  });
  assert.deepEqual(latchQueuedIngestMode({ durableMode: 'both', queuedMode: 'unknown' }), {
    ok: false, expected: 'both', actual: null,
  });
});

test('worker fails a tampered queued mode before it can enter ingestion', async () => {
  const failures = [];
  class UnrecoverableError extends Error {}
  const queue = Object.create(KbIngestQueue.prototype);
  Object.assign(queue, {
    _orgRunning: new Map(),
    _orgPending: new Map(),
    _bullmq: { UnrecoverableError },
    logger: { info() {} },
    jobStore: {
      findOwned: async () => ({ id: 'job-1', status: 'queued', processingVersion: 1, ingestMode: 'evidence' }),
      fail: async (...args) => failures.push(args),
      progress: async () => assert.fail('worker must not advance a mismatched job'),
    },
    validateJob: async () => {},
  });
  const job = {
    attemptsMade: 0,
    opts: { attempts: 3 },
    data: {
      trackerJobId: 'job-1', userId: 'user-1', orgId: 'org-1', filename: 'report.pdf',
      processingVersion: 1, metadata: { ingest_mode: 'both' },
    },
  };

  await assert.rejects(queue._process(job), (error) => error.code === 'INGEST_MODE_MISMATCH');
  assert.equal(failures.length, 1);
  assert.equal(failures[0][2].code, 'INGEST_MODE_MISMATCH');
});

test('durable completion gate rejects partial evidence embedding coverage', () => {
  assert.throws(() => requireCompleteEvidenceEmbedding({
    documentId: 'doc-1', segmentCount: 3,
    coverage: { evidence_embed: { total: 3, embedded: 2, failed: 1, healed: 0 } },
  }), (error) => {
    assert.equal(error.code, 'PARTIAL_EMBEDDING');
    assert.equal(error.retryable, true);
    assert.match(error.message, /1\/3 evidence segments/);
    return true;
  });

  assert.doesNotThrow(() => requireCompleteEvidenceEmbedding({
    documentId: 'doc-1', segmentCount: 3,
    coverage: { evidence_embed: { total: 3, embedded: 3, failed: 0, healed: 1 } },
  }));

  assert.throws(() => requireCompleteEvidenceEmbedding({
    documentId: 'doc-1', segmentCount: 3,
    coverage: { evidence_embed: { total: 3, embedded: 2, failed: 0, healed: 0 } },
  }), (error) => error.code === 'PARTIAL_EMBEDDING');
});

test('durable completion gate rejects partial promoted-memory vector coverage', () => {
  assert.throws(() => requireCompleteMemoryEmbedding({
    documentId: 'doc-1', promotedCount: 4,
    coverage: { memory_embed: { total: 4, embedded: 3, failed: 1, healed: 0 } },
  }), (error) => {
    assert.equal(error.code, 'PARTIAL_MEMORY_EMBEDDING');
    assert.equal(error.retryable, true);
    assert.match(error.message, /1\/4 promoted memories/);
    return true;
  });

  assert.doesNotThrow(() => requireCompleteMemoryEmbedding({
    documentId: 'doc-1', promotedCount: 4,
    coverage: { memory_embed: { total: 4, embedded: 4, failed: 0, healed: 1 } },
  }));

  assert.doesNotThrow(() => requireCompleteMemoryEmbedding({
    documentId: 'doc-1', promotedCount: 0, coverage: {},
  }));
});

test('confirmed dead Workflow is fenced into BullMQ exactly once', async () => {
  const writes = [];
  const enqueues = [];
  const queue = Object.create(KbIngestQueue.prototype);
  Object.assign(queue, {
    queue: {},
    jobStore: {
      claimWorkflowFallback: async (input) => { writes.push(input); return 4; },
      updateOwned: async (...args) => writes.push(['updateOwned', ...args]),
      fail: async () => assert.fail('successful fallback must not fail the new version'),
    },
    rawFilePath: () => '/tmp/local-source',
    enqueue: async (input) => { enqueues.push(input); return { queue_job_id: 'bull-job-v4' }; },
  });
  const result = await queue.fallbackWorkflowJob({
    id: 'job', orgId: 'org', userId: 'user', processingVersion: 3,
    orchestrationMode: 'cloudflare_workflow', checksum: 'a'.repeat(64), filename: 'doc.pdf',
    contentType: 'application/pdf', metadata: { ingest_mode: 'both' },
  }, { terminalStatus: 'terminated' });

  assert.equal(result.recovered, true);
  assert.equal(result.processingVersion, 4);
  assert.equal(writes[0].processingVersion, 3);
  assert.equal(enqueues[0].processingVersion, 4);
  assert.equal(enqueues[0].filePath, '/tmp/local-source');
  assert.equal(enqueues[0].metadata.workflow_fallback_count, 1);
});

test('Workflow fallback carries a completed evidence receipt into the fenced BullMQ version', async () => {
  const enqueues = [];
  const inherited = [];
  const queue = Object.create(KbIngestQueue.prototype);
  Object.assign(queue, {
    queue: {},
    stepStore: {
      _model: () => ({ findMany: async () => [{
        id: 'receipt-evidence', stageKey: 'evidence_commit', status: 'succeeded',
        outputRefs: {
          documentId: '44444444-4444-4444-8444-444444444444', pages: 1,
          segmentCount: 2, candidateCount: 0, promotedCount: 0,
          coverage: { evidence_embed: { total: 2, embedded: 2, failed: 0 } },
        },
      }] }),
      inheritSucceeded: async (input) => { inherited.push(input); return 3; },
    },
    jobStore: {
      claimWorkflowFallback: async () => 6,
      updateOwned: async () => {},
      fail: async () => assert.fail('resumable fallback must enqueue'),
    },
    rawFilePath: () => '/tmp/local-source',
    enqueue: async (input) => { enqueues.push(input); return { queue_job_id: 'bull-job-v6' }; },
  });
  const result = await queue.fallbackWorkflowJob({
    id: 'job', orgId: 'org', userId: 'user', processingVersion: 5,
    checksum: 'a'.repeat(64), filename: 'doc.pdf', contentType: 'application/pdf',
    metadata: { ingest_mode: 'both' },
  }, { terminalStatus: 'errored' });

  assert.equal(result.resumeStage, 'evidence_commit');
  assert.equal(enqueues[0].metadata.workflow_resume_from_version, 5);
  assert.equal(enqueues[0].metadata.workflow_resume_result.documentId, '44444444-4444-4444-8444-444444444444');
  assert.equal(inherited[0].fromVersion, 5);
  assert.equal(inherited[0].toVersion, 6);
});

test('BullMQ resumes a both-mode Workflow after evidence without reparsing source bytes', async () => {
  const calls = [];
  const documentId = '44444444-4444-4444-8444-444444444444';
  const queue = Object.create(KbIngestQueue.prototype);
  Object.assign(queue, {
    _orgRunning: new Map(), _orgPending: new Map(), _counters: { processed: 0 },
    logger: { info() {} }, tracker: null, _setStatus: async () => {}, recordUsage: null,
    jobStore: {
      findOwned: async () => ({
        id: 'job', status: 'queued', processingVersion: 2, ingestMode: 'both', metadata: { ingest_mode: 'both' },
      }),
      progress: async () => {},
      complete: async (...args) => { calls.push(['complete', ...args]); return true; },
      fail: async (...args) => calls.push(['fail', ...args]),
    },
    dfi: {
      ingestSource: async () => assert.fail('resume must not parse the source again'),
      reconcileEntityCoverage: async () => ({
        complete: true, expected: 4, completed: 4, failed: 0, pending: 0,
        authority: 'postgresql_receipts',
      }),
      promoteStoredEvidence: async (input) => {
        calls.push(['promote', input]);
        return {
          documentId, pages: 1, segmentCount: 2, candidateCount: 2, promotedCount: 1,
          promotedMemoryIds: ['55555555-5555-4555-8555-555555555555'],
          coverage: {
            evidence_embed: { total: 2, embedded: 2, failed: 0 },
            memory_embed: { total: 1, embedded: 1, failed: 0 },
          },
        };
      },
    },
    processUpload: async () => assert.fail('resume must not invoke upload parsing'),
  });
  const job = {
    attemptsMade: 0, opts: { attempts: 3 }, timestamp: Date.now(),
    data: {
      trackerJobId: 'job', userId: 'user', orgId: 'org', filename: 'doc.pdf',
      contentType: 'application/pdf', checksum: 'a'.repeat(64),
      filePath: '/definitely/missing/source.pdf', processingVersion: 2,
      metadata: {
        ingest_mode: 'both', workflow_resume_stage: 'evidence_commit',
        workflow_resume_result: {
          documentId, pages: 1, segmentCount: 2, candidateCount: 0, promotedCount: 0,
          coverage: { evidence_embed: { total: 2, embedded: 2, failed: 0 } },
        },
      },
    },
  };

  await assert.doesNotReject(() => queue._process(job));
  assert.equal(calls.filter(([kind]) => kind === 'promote').length, 1);
  assert.equal(calls.find(([kind]) => kind === 'promote')[1].promotionStrategy, 'workflow_to_bullmq_resume');
  assert.equal(calls.filter(([kind]) => kind === 'complete').length, 1);
  assert.equal(calls.filter(([kind]) => kind === 'fail').length, 0);
  assert.equal(calls.find(([kind]) => kind === 'complete')[4].coverage.entity_projection.complete, true);
});

test('Workflow fallback exhaustion leaves the confirmed failure terminal', async () => {
  const queue = Object.create(KbIngestQueue.prototype);
  Object.assign(queue, {
    queue: {},
    jobStore: { claimWorkflowFallback: async () => assert.fail('must not claim exhausted fallback') },
    rawFilePath: () => '/tmp/local-source',
  });
  const result = await queue.fallbackWorkflowJob({
    id: 'job', orgId: 'org', processingVersion: 2,
    metadata: { workflow_fallback_count: 1 },
  }, { terminalStatus: 'errored' });
  assert.deepEqual(result, { recovered: false, reason: 'fallback_exhausted' });
});

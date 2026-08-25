import assert from 'node:assert/strict';
import test from 'node:test';

import { KbIngestQueue, durableQueueJobId, isStoredEvidencePromotion, knowledgeIngestEvent, latchQueuedIngestMode } from '../../src/knowledge/kb-ingest-queue.js';

test('queue lifecycle events use the canonical knowledge.ingest namespace', () => {
  const event = JSON.parse(knowledgeIngestEvent('started', { job_id: 'job-1' }));
  assert.equal(event.event, 'knowledge.ingest.started');
  assert.equal(event.task, 'knowledge.ingest');
  assert.equal(event.job_id, 'job-1');
  assert.throws(() => knowledgeIngestEvent('progress'), /Unsupported knowledge ingest lifecycle phase/);
});

test('durable BullMQ IDs never contain the forbidden colon separator', () => {
  const id = durableQueueJobId('378c5f62-8848-48bc-be28-4f8af4d1e2b5', 2);
  assert.equal(id, '378c5f62-8848-48bc-be28-4f8af4d1e2b5-v2');
  assert.equal(id.includes(':'), false);
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

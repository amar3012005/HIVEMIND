const test = require('node:test');
const assert = require('node:assert');

const { createIngestionPipeline } = require('../../src/ingestion');
const { embedChunks, MAX_EMBED_TOKENS } = require('../../src/ingestion/embedder');
const { InMemoryVectorStore } = require('../../src/ingestion/indexer');

const noopMemoryWriter = {
  async persistChunk(chunk, context) {
    return {
      memory: {
        id: `${context.request_id}:${chunk.chunk_index}`,
      },
      edges_created: 0,
    };
  },
};

function waitForEvent(emitter, eventName, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      emitter.removeListener(eventName, handler);
      reject(new Error(`Timed out waiting for ${eventName}`));
    }, timeoutMs);

    function handler(payload) {
      clearTimeout(timeout);
      resolve(payload);
    }

    emitter.once(eventName, handler);
  });
}

test('ingest(payload) returns jobId immediately and completes all stage transitions', async () => {
  const pipeline = createIngestionPipeline({
    queue: { forceInMemory: true },
    vectorStore: new InMemoryVectorStore(),
    memoryWriter: noopMemoryWriter,
  });

  try {
    const completion = waitForEvent(pipeline.eventBus, 'memory.ingested');

    const enqueued = await pipeline.ingest({
      source_type: 'text',
      user_id: 'u-1',
      org_id: 'o-1',
      content: 'This is a short ingestion sample to verify full pipeline transitions.',
      idempotency_key: 'idemp-1',
    });

    assert.ok(enqueued.jobId);
    assert.strictEqual(enqueued.stage, 'Queued');

    const done = await completion;
    assert.strictEqual(done.status, 'Done');

    const stages = done.stage_transitions.map((entry) => entry.stage);
    assert.deepStrictEqual(stages, [
      'Extracting',
      'Chunking',
      'Embedding',
      'Indexing',
      'Done',
    ]);

    const audits = pipeline.auditLogger.getRecords();
    assert.strictEqual(audits.length, 1);
    assert.strictEqual(audits[0].chunks_created > 0, true);
  } finally {
    await pipeline.close();
  }
});

test('routes failed jobs to dead-letter queue after max retries', async () => {
  const pipeline = createIngestionPipeline({
    queue: { forceInMemory: true },
    vectorStore: new InMemoryVectorStore(),
    memoryWriter: noopMemoryWriter,
  });

  try {
    pipeline.orchestrator.process = async () => {
      throw new Error('forced failure');
    };

    await pipeline.ingest({
      source_type: 'text',
      user_id: 'u-2',
      org_id: 'o-2',
      content: 'fail me',
      idempotency_key: 'idemp-fail',
    });

    await new Promise((resolve) => setTimeout(resolve, 200));

    const dlqJobs = pipeline.queueSystem.dlq.getDLQJobs();
    assert.strictEqual(dlqJobs.length, 1);
    assert.strictEqual(dlqJobs[0].error, 'forced failure');
  } finally {
    await pipeline.close();
  }
});

test('PII is stripped and oversized chunks are skipped before embedding', async () => {
  const oversized = new Array(MAX_EMBED_TOKENS + 100).fill('token').join(' ');

  const embedded = await embedChunks([
    { chunk_index: 0, content: 'Contact me at test@example.com or 123-45-6789' },
    { chunk_index: 1, content: oversized },
  ], { documentTitle: 'Doc' }, {});

  assert.strictEqual(embedded.length, 1);
  assert.strictEqual(embedded[0].pii_flagged, true);
  assert.ok(embedded[0].content_for_embedding.includes('[REDACTED_PII]'));
  assert.strictEqual(Array.isArray(embedded[0].embedding), true);
  assert.strictEqual(embedded[0].embedding.length, 1536);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { SyncEngine } from '../../src/connectors/framework/sync-engine.js';

test('connector sync routes records through the canonical ingest envelope', async () => {
  const envelopes = [];
  const engine = new SyncEngine({
    connectorStore: {},
    memoryStore: {},
    memoryEngine: { ingestMemory: async () => { throw new Error('legacy ingest must not run'); } },
    getCanonicalIngestion: () => ({
      ingestSource: async (envelope) => {
        envelopes.push(envelope);
        return { ok: true, mode: 'document', documentId: 'doc-1', memoryIds: ['m1'] };
      },
    }),
  });

  const result = await engine._ingestWithRetry({
    title: 'Customer thread',
    content: 'A sufficiently useful connector record.',
    target_scope: 'organization',
    memory_type: 'event',
    document_date: '2026-07-14T10:00:00Z',
    source_metadata: {
      source_platform: 'connector:gmail',
      source_id: 'thread-1',
      source_url: 'https://mail.example/thread-1',
    },
  }, 'thread-1', 'user-1', 'org-1');

  assert.equal(result.ok, true);
  assert.equal(envelopes.length, 1);
  assert.equal(envelopes[0].orgId, 'org-1');
  assert.equal(envelopes[0].scope, 'organization');
  assert.equal(envelopes[0].source.type, 'connector');
  assert.equal(envelopes[0].source.provider, 'gmail');
  assert.equal(envelopes[0].source.sourceId, 'thread-1');
  assert.equal(envelopes[0].metadata.memory_type, 'event');
});

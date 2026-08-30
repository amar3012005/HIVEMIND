import test from 'node:test';
import assert from 'node:assert/strict';
import {
  captureDocumentProjection,
  reconcileDocumentProjection,
} from '../../src/knowledge/document-projection-replacement.js';

test('captures a unique pre-reprocess projection', async () => {
  const db = { memoryEvidenceLink: { findMany: async () => [
    { memoryId: 'old-a' }, { memoryId: 'old-a' }, { memoryId: 'old-b' },
  ] } };
  assert.deepEqual(await captureDocumentProjection(db, 'doc-1'), ['old-a', 'old-b']);
});

test('retires only stale memories whose sole support is the replaced document', async () => {
  const calls = [];
  const tx = {
    memoryEvidenceLink: { deleteMany: async (args) => calls.push(['links', args]) },
    relationship: { deleteMany: async (args) => calls.push(['relationships', args]) },
    vectorEmbedding: { deleteMany: async (args) => calls.push(['vector-row', args]) },
    memory: { updateMany: async (args) => calls.push(['retire', args]) },
  };
  const db = {
    memoryEvidenceLink: { findMany: async () => [
      { memoryId: 'old-a', documentId: 'doc-1' },
      { memoryId: 'old-b', documentId: 'doc-1' },
      { memoryId: 'old-b', documentId: 'doc-2' },
    ] },
    $transaction: async (fn) => fn(tx),
  };
  const deletedVectors = [];
  const result = await reconcileDocumentProjection({
    db,
    vectorStore: { deleteMemory: async (id) => { deletedVectors.push(id); return true; } },
    documentId: 'doc-1',
    previousMemoryIds: ['old-a', 'old-b', 'kept'],
    currentMemoryIds: ['kept', 'new-a'],
  });

  assert.deepEqual(result, { stale: 2, retired: 1, detached: 1 });
  assert.deepEqual(deletedVectors, ['old-a']);
  assert.deepEqual(calls[0][1].where, {
    documentId: 'doc-1', memoryId: { in: ['old-a', 'old-b'] },
  });
  assert.deepEqual(calls.at(-1)[1].where, { id: { in: ['old-a'] }, deletedAt: null });
});

test('does not alter PostgreSQL when vector cleanup fails', async () => {
  let transactionCalled = false;
  const db = {
    memoryEvidenceLink: { findMany: async () => [{ memoryId: 'old-a', documentId: 'doc-1' }] },
    $transaction: async () => { transactionCalled = true; },
  };
  await assert.rejects(
    reconcileDocumentProjection({
      db,
      vectorStore: { deleteMemory: async () => false },
      documentId: 'doc-1', previousMemoryIds: ['old-a'], currentMemoryIds: ['new-a'],
    }),
    /vector cleanup failed/,
  );
  assert.equal(transactionCalled, false);
});

test('is idempotent when the current projection is unchanged', async () => {
  const result = await reconcileDocumentProjection({
    db: { memoryEvidenceLink: { findMany: async () => [{ memoryId: 'same' }] } },
    documentId: 'doc-1', previousMemoryIds: ['same'], currentMemoryIds: ['same'],
  });
  assert.deepEqual(result, { stale: 0, retired: 0, detached: 0 });
});

test('cleans a same-run citation whose memory was removed by consolidation', async () => {
  const deleted = [];
  const tx = {
    memoryEvidenceLink: { deleteMany: async () => {} },
    relationship: { deleteMany: async () => {} },
    memory: { updateMany: async () => {} },
  };
  let read = 0;
  const db = {
    memoryEvidenceLink: { findMany: async () => {
      read += 1;
      return read === 1
        ? [{ memoryId: 'same-run-retired' }]
        : [{ memoryId: 'same-run-retired', documentId: 'doc-1' }];
    } },
    $transaction: async (fn) => fn(tx),
  };
  const result = await reconcileDocumentProjection({
    db, vectorStore: { deleteMemory: async (id) => { deleted.push(id); return true; } },
    documentId: 'doc-1', previousMemoryIds: [], currentMemoryIds: ['kept'],
  });
  assert.deepEqual(result, { stale: 1, retired: 1, detached: 0 });
  assert.deepEqual(deleted, ['same-run-retired']);
});

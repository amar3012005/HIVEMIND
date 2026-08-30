import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentFirstIngestionService } from '../../src/knowledge/document-first-ingestion.js';

test('projects every promoted memory through the injected canonical boundary', async () => {
  const calls = [];
  const service = new DocumentFirstIngestionService({
    canonicalProjector: async (input) => {
      calls.push(input);
      return { memoryId: input.memory.id, status: 'complete' };
    },
  });

  const receipts = await service._projectPromotedCanonicalKnowledge({
    memories: [{ id: 'm-1', content: 'Uwe teaches Deep Learning.' }, { id: 'm-2', content: 'Uwe teaches Quantum Computing.' }],
    userId: 'user-1', orgId: 'org-1', documentId: 'doc-1',
  });

  assert.deepEqual(calls.map(({ memory, userId, orgId, documentId }) => ({
    memoryId: memory.id, userId, orgId, documentId,
  })), [
    { memoryId: 'm-1', userId: 'user-1', orgId: 'org-1', documentId: 'doc-1' },
    { memoryId: 'm-2', userId: 'user-1', orgId: 'org-1', documentId: 'doc-1' },
  ]);
  assert.equal(receipts.length, 2);
});

test('isolates a failed canonical projection without skipping later memories', async () => {
  const calls = [];
  const service = new DocumentFirstIngestionService({
    canonicalProjector: async ({ memory }) => {
      calls.push(memory.id);
      if (memory.id === 'm-1') throw new Error('temporary projection outage');
      return { memoryId: memory.id, status: 'complete' };
    },
  });

  const receipts = await service._projectPromotedCanonicalKnowledge({
    memories: [{ id: 'm-1', content: 'one' }, { id: 'm-2', content: 'two' }],
    userId: 'user-1', orgId: 'org-1', documentId: 'doc-1',
  });

  assert.deepEqual(calls, ['m-1', 'm-2']);
  assert.equal(receipts[0].status, 'degraded');
  assert.equal(receipts[1].status, 'complete');
});

test('latches one admitted feature mode across all memories in a document', async () => {
  const admittedModes = [];
  const service = new DocumentFirstIngestionService({
    canonicalProjector: async ({ memory, admittedMode }) => {
      admittedModes.push(admittedMode);
      return { memoryId: memory.id, mode: admittedMode || 'full', status: 'complete' };
    },
  });

  await service._projectPromotedCanonicalKnowledge({
    memories: [{ id: 'm-1' }, { id: 'm-2' }, { id: 'm-3' }],
    userId: 'user-1', orgId: 'org-1', documentId: 'doc-1',
  });

  assert.deepEqual(admittedModes, [null, 'full', 'full']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { collectDerivedCandidates, pruneOrphanedCognition } from '../../src/memory/orphan-pruner.js';

// Minimal in-memory prisma double. `memories` is a map id -> row.
function makePrisma({ memories = {}, relationships = [], evidenceLinks = [], liveDocIds = [] } = {}) {
  const alive = (id) => memories[id] && memories[id].deletedAt == null;
  return {
    deleted: [],
    memory: {
      findUnique: async ({ where }) => memories[where.id] || null,
      findMany: async ({ where }) => {
        // used by collectDerivedCandidates: synthesisEvidenceIds hasSome ids
        const ids = where.synthesisEvidenceIds?.hasSome || [];
        return Object.values(memories).filter(m => m.deletedAt == null && (m.synthesisEvidenceIds || []).some(e => ids.includes(e)));
      },
      count: async ({ where }) => (where.id?.in || []).filter(id => alive(id)).length,
      deleteMany: async ({ where }) => {
        const ids = where.id?.in || [];
        for (const id of ids) { delete memories[id]; }
        return { count: ids.length };
      },
    },
    relationship: {
      findMany: async ({ where }) => {
        if (where.toId?.in) return relationships.filter(r => r.type === where.type && where.toId.in.includes(r.toId)).map(r => ({ fromId: r.fromId }));
        if (where.fromId) return relationships.filter(r => r.type === where.type && r.fromId === where.fromId).map(r => ({ toId: r.toId }));
        return [];
      },
      deleteMany: async () => ({ count: 0 }),
    },
    memoryEvidenceLink: {
      findMany: async ({ where }) => evidenceLinks.filter(l => l.memoryId === where.memoryId).map(l => ({ documentId: l.documentId })),
      deleteMany: async () => ({ count: 0 }),
    },
    knowledgeDocument: { count: async ({ where }) => (where.id?.in || []).filter(id => liveDocIds.includes(id)).length },
    memoryProject: { deleteMany: async () => ({ count: 0 }) },
    sourceMetadata: { deleteMany: async () => ({ count: 0 }) },
    memoryVersion: { updateMany: async () => ({ count: 0 }), deleteMany: async () => ({ count: 0 }) },
  };
}

test('collectDerivedCandidates finds Derives parents + evidence refs of deleted roots', async () => {
  const prisma = makePrisma({
    memories: { synthA: { id: 'synthA', deletedAt: null, synthesisEvidenceIds: ['src1'] } },
    relationships: [{ fromId: 'synthB', toId: 'src1', type: 'Derives' }],
  });
  const cands = await collectDerivedCandidates(prisma, ['src1']);
  assert.deepEqual(cands.sort(), ['synthA', 'synthB']);
});

test('prunes a synthesis whose only Derives source was deleted', async () => {
  const prisma = makePrisma({
    memories: { synthA: { id: 'synthA', deletedAt: null, memoryType: 'synthesis', tags: [], synthesisEvidenceIds: [] } },
    relationships: [{ fromId: 'synthA', toId: 'src1', type: 'Derives' }], // src1 already gone (not in memories)
  });
  const { prunedIds } = await pruneOrphanedCognition({ prisma, orgId: 'o', candidateIds: ['synthA'], logger: { log() {}, warn() {} } });
  assert.deepEqual(prunedIds, ['synthA']);
});

test('keeps a synthesis that still has a live Derives source', async () => {
  const prisma = makePrisma({
    memories: {
      synthA: { id: 'synthA', deletedAt: null, memoryType: 'synthesis', tags: [], synthesisEvidenceIds: [] },
      srcLive: { id: 'srcLive', deletedAt: null, memoryType: 'fact', tags: [] },
    },
    relationships: [{ fromId: 'synthA', toId: 'srcLive', type: 'Derives' }],
  });
  const { prunedIds } = await pruneOrphanedCognition({ prisma, orgId: 'o', candidateIds: ['synthA'], logger: { log() {}, warn() {} } });
  assert.deepEqual(prunedIds, []);
});

test('never prunes a non-cognition (source) memory even if dangling', async () => {
  const prisma = makePrisma({
    memories: { raw: { id: 'raw', deletedAt: null, memoryType: 'fact', tags: [], synthesisEvidenceIds: [] } },
    relationships: [{ fromId: 'raw', toId: 'gone', type: 'Derives' }],
  });
  const { prunedIds } = await pruneOrphanedCognition({ prisma, orgId: 'o', candidateIds: ['raw'], logger: { log() {}, warn() {} } });
  assert.deepEqual(prunedIds, []);
});

test('keeps a distilled-from-kb fact whose KB doc is still live', async () => {
  const prisma = makePrisma({
    memories: { fact1: { id: 'fact1', deletedAt: null, memoryType: 'fact', tags: ['distilled-from-kb'], synthesisEvidenceIds: [] } },
    evidenceLinks: [{ memoryId: 'fact1', documentId: 'docLive' }],
    liveDocIds: ['docLive'],
  });
  const { prunedIds } = await pruneOrphanedCognition({ prisma, orgId: 'o', candidateIds: ['fact1'], logger: { log() {}, warn() {} } });
  assert.deepEqual(prunedIds, []);
});

test('prunes a distilled-from-kb fact whose KB doc was deleted', async () => {
  const prisma = makePrisma({
    memories: { fact1: { id: 'fact1', deletedAt: null, memoryType: 'fact', tags: ['distilled-from-kb'], synthesisEvidenceIds: [] } },
    evidenceLinks: [{ memoryId: 'fact1', documentId: 'docGone' }],
    liveDocIds: [],
  });
  const { prunedIds } = await pruneOrphanedCognition({ prisma, orgId: 'o', candidateIds: ['fact1'], logger: { log() {}, warn() {} } });
  assert.deepEqual(prunedIds, ['fact1']);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { handleQuickSearchRoute, handleRecallRoute } from '../../src/routes/recall.js';

function jsonResponse(_res, body, statusCode = 200) {
  return { statusCode, body };
}

test('recall route rejects project-scoped access the caller does not have', async () => {
  const result = await handleRecallRoute({
    req: {},
    res: {},
    body: { query_context: 'project memory', project_id: 'proj-2' },
    userId: 'user-1',
    orgId: 'org-1',
    prisma: {},
    jsonResponse,
    ensurePersistedMemoryOrFail: () => true,
    rateLimitAllowOrgRequest: () => true,
    planEnforcer: null,
    cognitiveOperator: null,
    detectQueryIntent: () => 'fact_lookup',
    computeDynamicWeights: () => ({}),
    expandTemporalQuery: () => ({}),
    rewriteQuery: (q) => ({ expanded: q, entities: [], stripped: q }),
    effectiveContainerTag: null,
    buildAccessContext: async () => ({ projectIds: ['proj-1'], teamIds: [] }),
    isUuidLike: () => false,
    recallPersistedMemories: async () => ({ memories: [] }),
    persistentMemoryStore: { getRelationships: async () => [] },
    ClusterIndex: class {},
    crossClusterEntityBoost: async (m) => m,
    deduplicateResults: (m) => m,
    profileStore: null,
    evidenceRetrieval: null,
    amrBumpRecall: () => {},
    qdrantClient: null,
    getMemoryTypeBoost: () => 1,
  });

  assert.equal(result.statusCode, 403);
  assert.equal(result.body.error, 'Project not found or access denied');
});

test('recall route returns rate limit response before recall work', async () => {
  let called = false;
  const result = await handleRecallRoute({
    req: {},
    res: {},
    body: { query_context: 'anything' },
    userId: 'user-1',
    orgId: 'org-1',
    prisma: {},
    jsonResponse,
    ensurePersistedMemoryOrFail: () => true,
    rateLimitAllowOrgRequest: () => false,
    planEnforcer: null,
    cognitiveOperator: null,
    detectQueryIntent: () => 'fact_lookup',
    computeDynamicWeights: () => ({}),
    expandTemporalQuery: () => ({}),
    rewriteQuery: (q) => ({ expanded: q, entities: [], stripped: q }),
    effectiveContainerTag: null,
    buildAccessContext: async () => ({ projectIds: [], teamIds: [] }),
    isUuidLike: () => false,
    recallPersistedMemories: async () => {
      called = true;
      return { memories: [] };
    },
    persistentMemoryStore: { getRelationships: async () => [] },
    ClusterIndex: class {},
    crossClusterEntityBoost: async (m) => m,
    deduplicateResults: (m) => m,
    profileStore: null,
    evidenceRetrieval: null,
    amrBumpRecall: () => {},
    qdrantClient: null,
    getMemoryTypeBoost: () => 1,
  });

  assert.equal(result.statusCode, 429);
  assert.equal(called, false);
});

test('quick search route uses unified recall response shape', async () => {
  const result = await handleQuickSearchRoute({
    res: {},
    body: { query: 'hello', limit: 2 },
    userId: 'user-1',
    orgId: 'org-1',
    jsonResponse,
    ensurePersistedMemoryOrFail: () => true,
    effectiveContainerTag: null,
    buildAccessContext: async () => ({ projectIds: [], teamIds: [] }),
    recallPersistedMemories: async () => ({
      memories: [{ id: 'm1', title: 'Hello' }],
      evidence: [{ segment_id: 's1' }],
    }),
    persistentMemoryStore: {},
    planEnforcer: null,
  });

  assert.equal(result.statusCode, 200);
  assert.equal(result.body.source, 'unified-recall');
  assert.equal(result.body.count, 1);
  assert.equal(result.body.memories[0].id, 'm1');
});

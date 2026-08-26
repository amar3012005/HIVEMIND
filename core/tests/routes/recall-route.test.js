import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildMemoryEvidenceLinkWhere,
  buildRecallEnhanceContext,
  handleQuickSearchRoute,
  handleRecallRoute,
  legacyInitialCrossRerank,
  normalizeRecallLimit,
} from '../../src/routes/recall.js';

function jsonResponse(_res, body, statusCode = 200) {
  return { statusCode, body };
}

test('public recall limits retain 15 by default and honor bounded caller limits', () => {
  assert.equal(normalizeRecallLimit(undefined), 15);
  assert.equal(normalizeRecallLimit(12), 12);
  assert.equal(normalizeRecallLimit(500), 50);
  assert.equal(normalizeRecallLimit(0), 15);
});

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

test('legacy recall selects one cross-encoder authority for each response mode', () => {
  assert.equal(legacyInitialCrossRerank('quick', true), false);
  assert.equal(legacyInitialCrossRerank('auto', null), false);
  assert.equal(legacyInitialCrossRerank('memory', true), true);
  assert.equal(legacyInitialCrossRerank('memory', null), null);
});

test('legacy recall forwards the selected project to evidence enhancement', () => {
  const accessContext = { projectIds: ['project-1'], teamIds: [] };
  assert.deepEqual(buildRecallEnhanceContext({
    userId: 'user-1', orgId: 'org-1', projectId: 'project-1',
    accessContext, scopeFilter: 'project',
  }), {
    userId: 'user-1', orgId: 'org-1', projectId: 'project-1',
    accessContext, scopeFilter: 'project',
  });
});

test('linked evidence for shared memories is narrowed to the selected project', () => {
  assert.deepEqual(buildMemoryEvidenceLinkWhere(['memory-1'], 'project-1'), {
    memoryId: { in: ['memory-1'] },
    document: { tags: { has: 'scope-key:project:project-1' } },
  });
  assert.deepEqual(buildMemoryEvidenceLinkWhere(['memory-1']), {
    memoryId: { in: ['memory-1'] },
  });
});

test('explicit recall modes use the bounded context service and return a RecallPacket', async () => {
  let directPersistedRecallCalled = false;
  let forwardedOptions = null;
  const packet = {
    facts: [{ id: 'm1' }],
    sourceSections: [{ segment_id: 's1' }],
    timeline: [],
    conflicts: [],
    graphEvidence: [],
    liveEvidence: [],
    citations: [{ id: 'C1', segment_id: 's1' }],
    coverage: { facts: 1, source_sections: 1 },
    cutoff_reason: null,
  };
  const result = await handleRecallRoute({
    req: {},
    res: {},
    body: { query_context: 'ground this', mode: 'explain', limit: 15 },
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
    buildAccessContext: async () => ({ projectIds: [], teamIds: [] }),
    isUuidLike: () => false,
    recallPersistedMemories: async () => {
      directPersistedRecallCalled = true;
      return { memories: [] };
    },
    persistentMemoryStore: {},
    ClusterIndex: class {},
    crossClusterEntityBoost: async (m) => m,
    deduplicateResults: (m) => m,
    profileStore: null,
    evidenceRetrieval: null,
    amrBumpRecall: () => {},
    qdrantClient: null,
    getMemoryTypeBoost: () => 1,
    recallRuntime: {
      resolvePlan: () => ({
        mode: 'explain', legacy: false, max_graph_hops: 1,
        latency_budget_ms: 3000,
        source: { requested: true, document_id: 'doc-1', title: 'Brochure.pdf' },
        time: { mode: 'known_at', known_at: '2026-07-01T00:00:00.000Z' },
      }),
      recall: async (_query, options) => {
        forwardedOptions = options;
        return ({
        memories: [{ id: 'm1', content: 'grounded fact' }],
        evidence: [{ segment_id: 's1', content: 'source quote' }],
        ranked_candidates: [
          { kind: 'evidence', segment_id: 's1', rank: 1, score: 0.96 },
          { kind: 'memory', memory_id: 'm1', rank: 2, score: 0.91 },
        ],
        live: [],
        trace: { cutoff_reason: null },
        });
      },
      loadGraph: async () => ({ items: [], reason: null }),
      buildPacket: () => packet,
    },
  });

  assert.equal(result.statusCode, 200);
  assert.equal(directPersistedRecallCalled, false);
  assert.equal(result.body.mode_used, 'explain');
  assert.equal(result.body.evidence_packet, packet);
  assert.equal(result.body.evidence_packet.citations[0].id, 'C1');
  assert.deepEqual(result.body.results.map((row) => `${row.kind}:${row.id}`), [
    'evidence:s1', 'memory:m1',
  ]);
  assert.equal(result.body.results[0].score, 0.96);
  assert.equal(result.body.results[0].citation_id, 'evidence:s1');
  assert.deepEqual(forwardedOptions.source, {
    requested: true,
    document_id: 'doc-1',
    title: 'Brochure.pdf',
  });
  assert.deepEqual(forwardedOptions.time, {
    mode: 'known_at',
    known_at: '2026-07-01T00:00:00.000Z',
  });
  assert.equal(forwardedOptions.limit, 15);
});

test('recall route forwards typed source and time blocks unchanged', async () => {
  let forwarded = null;
  const source = { document_id: 'doc-1', title: 'Brochure.pdf' };
  const time = { known_at: '2026-07-01T00:00:00.000Z' };
  const result = await handleRecallRoute({
    req: {}, res: {}, body: {
      query_context: 'approval', mode: 'explain', source, time,
      entities: ['Kruti'], memory_types: ['decision'], scope_filter: 'project',
      relationship_types: ['Supports'], relationship_direction: 'incoming',
    },
    userId: 'user-1', orgId: 'org-1', prisma: {}, jsonResponse,
    ensurePersistedMemoryOrFail: () => true, rateLimitAllowOrgRequest: () => true,
    planEnforcer: null, cognitiveOperator: null, detectQueryIntent: () => 'fact_lookup',
    computeDynamicWeights: () => ({}), expandTemporalQuery: () => ({}),
    rewriteQuery: (q) => ({ expanded: q, entities: [], stripped: q }),
    effectiveContainerTag: null, buildAccessContext: async () => ({ projectIds: [], teamIds: [] }),
    isUuidLike: () => false, recallPersistedMemories: async () => ({ memories: [] }),
    persistentMemoryStore: {}, ClusterIndex: class {}, crossClusterEntityBoost: async (m) => m,
    deduplicateResults: (m) => m, profileStore: null, evidenceRetrieval: null,
    amrBumpRecall: () => {}, qdrantClient: null, getMemoryTypeBoost: () => 1,
    recallRuntime: {
      resolvePlan: () => ({
        mode: 'explain', legacy: false, max_graph_hops: 0, latency_budget_ms: 3000,
        source: { requested: true, ...source }, time: { mode: 'known_at', ...time },
        entities: ['Kruti'], entity_filter_mode: 'must', memory_types: ['decision'],
        scope_filter: 'project', relationships: { requested: true, types: ['supports'], direction: 'incoming' },
      }),
      recall: async (_query, options) => { forwarded = options; return { memories: [], evidence: [], live: [], trace: {} }; },
      loadGraph: async () => ({ items: [] }),
      buildPacket: () => ({ citations: [] }),
    },
  });

  assert.equal(result.statusCode, 200);
  assert.deepEqual(forwarded.source, { requested: true, ...source });
  assert.deepEqual(forwarded.time, { mode: 'known_at', ...time });
  assert.deepEqual(forwarded.memory_types, ['decision']);
  assert.equal(forwarded.entity_filter_mode, 'must');
  assert.equal(forwarded.scope_filter, 'project');
  assert.deepEqual(forwarded.relationships, { requested: true, types: ['supports'], direction: 'incoming' });
});

test('a sovereign Memory Box outage returns 503 and never masquerades as zero recall', async () => {
  const unavailable = Object.assign(new Error('box transport failed'), {
    code: 'REMOTE_MEMORY_UNAVAILABLE',
  });
  const result = await handleRecallRoute({
    req: {}, res: {}, body: { query_context: 'company details', mode: 'fact' },
    userId: 'user-1', orgId: 'org-1', prisma: {}, jsonResponse,
    ensurePersistedMemoryOrFail: () => true, rateLimitAllowOrgRequest: () => true,
    planEnforcer: null, cognitiveOperator: null, detectQueryIntent: () => 'fact_lookup',
    computeDynamicWeights: () => ({}), expandTemporalQuery: () => ({}),
    rewriteQuery: (q) => ({ expanded: q, entities: [], stripped: q }),
    effectiveContainerTag: null, buildAccessContext: async () => ({ projectIds: [], teamIds: [] }),
    isUuidLike: () => false, recallPersistedMemories: async () => ({ memories: [] }),
    persistentMemoryStore: {}, ClusterIndex: class {}, crossClusterEntityBoost: async (m) => m,
    deduplicateResults: (m) => m, profileStore: null, evidenceRetrieval: null,
    amrBumpRecall: () => {}, qdrantClient: null, getMemoryTypeBoost: () => 1,
    recallRuntime: {
      resolvePlan: () => ({ mode: 'fact', legacy: false, max_graph_hops: 0, latency_budget_ms: 3000 }),
      recall: async () => { throw unavailable; },
      loadGraph: async () => ({ items: [] }),
      buildPacket: () => ({ citations: [] }),
    },
  });

  assert.equal(result.statusCode, 503);
  assert.equal(result.body.error, 'memory_unavailable');
  assert.equal(result.body.retryable, true);
  assert.match(result.body.message, /No absence conclusion/);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalEntityLexicalQuery,
  filterMemoriesByEntities,
  filterMemoriesByRelationships,
  loadTypedGraphEvidence,
  orderTemporalCandidates,
  RecallRouter,
  isLiveExpansionEligible,
  resolveCanonicalEntities,
  resolveRecallPlan,
  restrictTimelineCandidates,
} from '../../src/memory/recall-router.js';

const emptyStore = (overrides = {}) => ({
  searchMemories: async () => [],
  listRelationships: async () => [],
  listMemories: async () => ({ memories: [], total: 0 }),
  getMemories: async () => [],
  getMemory: async () => null,
  getRelatedMemories: async () => [],
  ...overrides,
});

const embeddingEvidence = (overrides = {}) => ({
  qdrantClient: { generateEmbedding: async () => [1, 0] },
  retrieveEvidence: async () => [],
  ...overrides,
});

test('RetrievalSpec preserves hard entity, scope, source, type and relationship predicates', () => {
  const plan = resolveRecallPlan({
    mode: 'explain',
    entities: ['Kruti'],
    entity_filter_mode: 'must',
    memory_types: ['decision'],
    source: { title: 'Board Notes.pdf', kind: 'kb' },
    scope_filter: 'organization',
    relationship_types: ['Updates', 'Supports'],
    relationship_direction: 'incoming',
    time: { selector: 'latest', axis: 'known_time' },
  });
  assert.deepEqual(plan.entities, ['Kruti']);
  assert.equal(plan.entity_filter_mode, 'must');
  assert.deepEqual(plan.memory_types, ['decision']);
  assert.equal(plan.source.title, 'Board Notes.pdf');
  assert.equal(plan.source.kind, 'kb');
  assert.equal(plan.scope_filter, 'organization');
  assert.deepEqual(plan.relationships, {
    requested: true, types: ['updates', 'supports'], direction: 'incoming',
  });
  assert.equal(plan.time.selector, 'latest');
});

test('RetrievalSpec accepts planner time mode, semantics, direct range, and as_of aliases', () => {
  const latestByMode = resolveRecallPlan({
    mode: 'full', explicit_mode: true,
    time: { mode: 'latest', axis: 'known_time' },
  });
  assert.equal(latestByMode.time.selector, 'latest');
  assert.equal(latestByMode.time.mode, 'latest');

  const latestBySemantics = resolveRecallPlan({
    mode: 'full', explicit_mode: true,
    time: { semantics: 'latest', axis: 'event_time' },
  });
  assert.equal(latestBySemantics.time.selector, 'latest');
  assert.equal(latestBySemantics.time.axis, 'event_time');

  const ranged = resolveRecallPlan({
    mode: 'full', explicit_mode: true,
    time: {
      semantics: 'range', axis: 'event_time',
      start: '2026-08-08T00:00:00+02:00',
      end: '2026-08-23T23:59:59.999+02:00',
    },
  });
  assert.equal(ranged.time.mode, 'range');
  assert.equal(ranged.time.range.start, '2026-08-07T22:00:00.000Z');
  assert.equal(ranged.time.range.end, '2026-08-23T21:59:59.999Z');

  const knownSnapshot = resolveRecallPlan({
    mode: 'full', explicit_mode: true,
    time: { semantics: 'snapshot', axis: 'known_time', as_of: '2026-08-23T12:00:00Z' },
  });
  assert.equal(knownSnapshot.time.mode, 'known_at');
  assert.equal(knownSnapshot.time.known_at, '2026-08-23T12:00:00.000Z');
});

test('RetrievalSpec honors max_memories as the public limit alias', () => {
  assert.equal(resolveRecallPlan({
    mode: 'full', explicit_mode: true, max_memories: 5,
  }).max_memories, 5);
  // The established `limit` field remains authoritative when both exist.
  assert.equal(resolveRecallPlan({
    mode: 'full', explicit_mode: true, limit: 7, max_memories: 5,
  }).max_memories, 7);
});

test('memory entity and relationship predicates are hard filters before delivery', () => {
  const rows = [
    { id: 'm1', title: 'Kruti update', tags: ['entity:kruti'] },
    { id: 'm2', title: 'Unrelated update', tags: ['entity:other'] },
  ];
  const entityRows = filterMemoriesByEntities(rows, ['Kruti'], { mode: 'must' });
  assert.deepEqual(entityRows.map((row) => row.id), ['m1']);
  const related = filterMemoriesByRelationships(entityRows, [
    { type: 'Updates', from_id: 'm0', to_id: 'm1' },
  ], { types: ['updates'], direction: 'incoming' });
  assert.deepEqual(related.map((row) => row.id), ['m1']);
});

test('typed relationship predicates are compiled into the graph query before its cap', async () => {
  let captured = null;
  await loadTypedGraphEvidence({
    prisma: { relationship: { findMany: async (args) => { captured = args; return []; } } },
    memoryIds: ['m1'], userId: 'u1', orgId: 'o1',
    accessContext: { orgRole: 'member', projectIds: [], teamIds: [] },
    relationship: { types: ['Supports'], direction: 'incoming' }, limit: 200,
  });
  assert.deepEqual(captured.where.toId, { in: ['m1'] });
  assert.deepEqual(captured.where.type, { in: ['Supports'] });
  assert.equal(captured.take, 200);
});

test('entity should remains a soft preference while relation endpoint matching uses any', () => {
  const rows = [
    { id: 'a', title: 'Kruti update', tags: ['entity:kruti'] },
    { id: 'b', title: 'Amar update', tags: ['entity:amar'] },
    { id: 'c', title: 'Unrelated', tags: ['entity:other'] },
  ];
  assert.equal(filterMemoriesByEntities(rows, ['Kruti'], { mode: 'should' }).length, 3);
  assert.deepEqual(
    filterMemoriesByEntities(rows, ['Kruti', 'Amar'], { mode: 'any' }).map((row) => row.id),
    ['a', 'b'],
  );
});

test('latest selection orders the wide pool by the selected clock with stable ties', () => {
  const rows = [
    { id: 'old-high-score', score: 0.99, known_at: '2026-08-20T00:00:00Z' },
    { id: 'new-low-score', score: 0.10, known_at: '2026-08-25T00:00:00Z' },
  ];
  assert.deepEqual(orderTemporalCandidates(rows, {
    selector: 'latest', axis: 'known_time', id: (row) => row.id,
  }).map((row) => row.id), ['new-low-score', 'old-high-score']);
});

test('canonical entity lexical lane protects exact entity phrases without rewriting the semantic query', () => {
  assert.equal(canonicalEntityLexicalQuery(['Kruti']), 'Kruti');
  assert.equal(
    canonicalEntityLexicalQuery(['Kruti', 'marketing team', 'Kruti', '  ']),
    'Kruti marketing team',
  );
  assert.equal(canonicalEntityLexicalQuery([]), null);
});

test('legacy recall modes preserve their existing event-driven behavior', () => {
  const plan = resolveRecallPlan({ mode: 'auto' });
  assert.equal(plan.legacy, true);
  assert.equal(plan.mode, 'fact');
  assert.equal(plan.expand_evidence, true);
  assert.equal(plan.include_live, true);
});

test('documented quick mode uses the parallel bounded hybrid plan and retains top fifteen', () => {
  const plan = resolveRecallPlan({ mode: 'quick' });
  assert.equal(plan.legacy, false);
  assert.equal(plan.requested_mode, 'quick');
  assert.equal(plan.mode, 'fact');
  assert.equal(plan.expand_evidence, true);
  assert.equal(plan.max_memories, 15);
});

test('explicit fact stays on the fast recall path', () => {
  const plan = resolveRecallPlan({ mode: 'fact', include_live: true, temporal: 'known_at' });
  assert.equal(plan.expand_evidence, true);
  assert.equal(plan.include_live, false);
  assert.equal(plan.max_graph_hops, 0);
  assert.equal(plan.max_memories, 15);
  assert.equal(plan.context_budget, 2_000);
  assert.equal(plan.latency_budget_ms, 1_500);
  assert.equal(plan.temporal, 'known_at');
});

test('explicit explain and full plans are bounded', () => {
  const explain = resolveRecallPlan({ mode: 'explain' });
  const full = resolveRecallPlan({ mode: 'full', explicit_mode: true, include_live: true });
  assert.deepEqual(
    [explain.context_budget, explain.max_graph_hops, explain.latency_budget_ms],
    [8_000, 1, 3_000],
  );
  assert.deepEqual(
    [full.context_budget, full.max_graph_hops, full.include_live, full.latency_budget_ms],
    [24_000, 1, true, 3_000],
  );
});

test('live expansion requires a surface policy and an evidence anchor or explicit intent', () => {
  const empty = { docIds: [], platforms: [] };
  assert.equal(isLiveExpansionEligible({ includeLive: true, inspection: empty }), false);
  assert.equal(isLiveExpansionEligible({ includeLive: true, inspection: empty, liveIntent: true }), true);
  assert.equal(isLiveExpansionEligible({
    includeLive: true,
    inspection: { docIds: ['doc-1'], platforms: [] },
    surfacePolicyAllowsLive: false,
  }), false);
});

test('explicit quick, fact, explain and full all include the parallel evidence lane', () => {
  assert.equal(resolveRecallPlan({ mode: 'quick' }).expand_evidence, true);
  assert.equal(resolveRecallPlan({ mode: 'fact' }).expand_evidence, true);
  assert.equal(resolveRecallPlan({ mode: 'explain' }).expand_evidence, true);
  assert.equal(resolveRecallPlan({ mode: 'full', explicit_mode: true }).expand_evidence, true);
});

test('full mode requires explicit caller provenance', () => {
  const inferred = resolveRecallPlan({ mode: 'full' });
  const explicit = resolveRecallPlan({ mode: 'full', explicit_mode: true });
  assert.equal(inferred.mode, 'explain');
  assert.equal(inferred.mode_downgraded, 'full_requires_explicit_caller');
  assert.equal(explicit.mode, 'full');
  assert.equal(explicit.mode_downgraded, null);
});

test('timeline is a bounded version-history operation on the shared plan', () => {
  const plan = resolveRecallPlan({
    mode: 'explain', operation: 'timeline', limit: 1000, target_memory_id: 'memory-current',
  });
  assert.equal(plan.operation, 'timeline');
  assert.equal(plan.max_memories, 50);
  assert.equal(plan.target_memory_id, 'memory-current');
});

test('targeted timeline removes unrelated semantic candidates before merge', () => {
  const restricted = restrictTimelineCandidates(
    [{ id: 'unrelated' }, { id: 'memory-current' }],
    [{ id: 'memory-old' }, { id: 'another-unrelated' }],
    new Set(['memory-current', 'memory-old']),
  );
  assert.deepEqual(restricted.memories.map((memory) => memory.id), ['memory-current']);
  assert.deepEqual(restricted.inventory.map((memory) => memory.id), ['memory-old']);
});

test('targeted timeline keeps a directly hydrated anchor with no Updates neighbors', () => {
  const restricted = restrictTimelineCandidates(
    [{ id: 'unrelated' }],
    [{ id: 'memory-current' }],
    new Set(['memory-current']),
  );
  assert.deepEqual(restricted.memories, []);
  assert.deepEqual(restricted.inventory.map((memory) => memory.id), ['memory-current']);
});

test('typed selectors and memory types survive plan recompilation', () => {
  const first = resolveRecallPlan({
    mode: 'explain',
    time: { selector: 'latest' },
    memory_types: ['Decision', 'event', 'decision'],
  });
  const second = resolveRecallPlan({ mode: first.mode, time: first.time, memory_types: first.memory_types });
  assert.equal(second.time.selector, 'latest');
  assert.deepEqual(second.memory_types, ['decision', 'event']);
});

test('latest temporal intent preserves the selected clock', () => {
  const plan = resolveRecallPlan({
    mode: 'fact',
    temporal_selector: 'latest',
    temporal_axis: 'event_time',
  });
  assert.equal(plan.time.selector, 'latest');
  assert.equal(plan.time.axis, 'event_time');
});

test('typed source and time blocks normalize legacy arguments with explicit precedence', () => {
  const plan = resolveRecallPlan({
    mode: 'explain',
    source_document_id: 'explicit-doc',
    source: { document_id: 'inferred-doc', title: 'Brochure.pdf' },
    known_at: '2026-07-01T12:00:00Z',
    time: { valid_at: '2025-01-01T00:00:00Z' },
  });
  assert.deepEqual(plan.source, {
    requested: true,
    document_id: 'explicit-doc',
    title: 'Brochure.pdf',
    kind: null,
  });
  assert.equal(plan.time.mode, 'known_at');
  assert.equal(plan.time.known_at, '2026-07-01T12:00:00.000Z');
  assert.equal(plan.temporal, 'known_at');
});

test('typed temporal ranges are validated and server-clamped', () => {
  const plan = resolveRecallPlan({
    mode: 'explain',
    time: { range: { start: '2020-01-01T00:00:00Z', end: '2026-01-01T00:00:00Z' } },
  });
  assert.equal(plan.time.mode, 'range');
  assert.equal(plan.time.range.clamped, true);
  assert.ok(new Date(plan.time.range.end) - new Date(plan.time.range.start) <= 366 * 24 * 60 * 60 * 1000);
  assert.equal(resolveRecallPlan({ mode: 'explain', time: { valid_at: 'invalid' } }).time.mode, 'current');
});

test('source identifiers are normalized and bounded by the server', () => {
  const plan = resolveRecallPlan({
    mode: 'explain',
    source_document_id: `  ${'d'.repeat(200)}  `,
    source_title: ` ${'t'.repeat(700)} `,
  });
  assert.equal(plan.source.document_id.length, 128);
  assert.equal(plan.source.title.length, 512);
  assert.equal(plan.source.requested, true);
});

test('Hop-0 resolves exact tenant entities and aliases without language keyword rules', async () => {
  let receivedWhere = null;
  const prisma = {
    entity: {
      findMany: async ({ where }) => {
        receivedWhere = where;
        return [{ canonicalName: 'Cognitive Swarm Intelligence' }, { canonicalName: 'CSI' }];
      },
    },
  };

  const entities = await resolveCanonicalEntities({
    prisma,
    orgId: 'org-1',
    query: 'what is the most groundbreaking thing with csi?',
  });

  assert.deepEqual(entities, ['Cognitive Swarm Intelligence', 'CSI']);
  assert.equal(receivedWhere.orgId, 'org-1');
  assert.equal(receivedWhere.isActive, true);
  assert.ok(receivedWhere.OR.some((clause) => clause.aliases?.hasSome?.includes('CSI')));
  assert.ok(receivedWhere.OR.some((clause) => clause.canonicalName?.equals === 'groundbreaking thing with csi'));
});

test('Hop-0 resolves implicit source artifacts before broad recall', async () => {
  const router = new RecallRouter({
    persistentMemoryStore: emptyStore(),
    evidenceRetrieval: embeddingEvidence({
      resolveSourceFromQuery: async ({ query }) => query.includes('Wald.pdf')
        ? [{ id: 'doc-1', document_title: 'Wald.pdf' }]
        : [],
      resolveSourceDocuments: async ({ documentId }) => documentId === 'doc-1'
        ? [{ id: 'doc-1', title: 'Wald.pdf' }]
        : [],
      hydrateSourceDocuments: async () => ({ items: [] }),
    }),
    prisma: null,
  });

  const result = await router.recall('Was steht in Wald.pdf?', { mode: 'explain' }, {
    userId: 'user-1',
    orgId: 'org-1',
  });

  assert.equal(result.trace.recall_plan.source.document_id, 'doc-1');
  assert.equal(result.trace.recall_plan.source.title, 'Wald.pdf');
});

test('structured chat intent does not convert an entity match into a source filter', async () => {
  const router = new RecallRouter({
    persistentMemoryStore: emptyStore(),
    evidenceRetrieval: embeddingEvidence({
      resolveSourceFromQuery: async () => [{ id: 'unrelated-doc', document_title: 'Solvis brochure.pdf' }],
    }),
    prisma: null,
  });

  const result = await router.recall('What do you know about Solvis?', {
    mode: 'fact',
    structured_intent: true,
  }, { userId: 'user-1', orgId: 'org-1' });

  assert.equal(result.trace.recall_plan.source.requested, false);
  assert.equal(result.trace.recall_plan.source.document_id, null);
});

test('structured chat intent resolves a literal filename as a source boundary', async () => {
  const router = new RecallRouter({
    persistentMemoryStore: emptyStore(),
    evidenceRetrieval: embeddingEvidence({
      resolveSourceFromQuery: async () => [{
        id: 'solvis-pia-doc',
        document_title: 'SolvisPia.pdf',
        _sourceMatch: 'filename',
      }],
      resolveSourceDocuments: async () => [],
    }),
    prisma: null,
  });

  const result = await router.recall('What does SolvisPia.pdf say about refrigerant?', {
    mode: 'explain',
    structured_intent: true,
  }, { userId: 'user-1', orgId: 'org-1' });

  assert.equal(result.trace.recall_plan.source.requested, true);
  assert.equal(result.trace.recall_plan.source.document_id, 'solvis-pia-doc');
});

test('an unresolved explicit source fails closed before memory recall', async () => {
  let recalled = false;
  const router = new RecallRouter({
    persistentMemoryStore: emptyStore({ recall: async () => { recalled = true; return { memories: [] }; } }),
    evidenceRetrieval: embeddingEvidence({
      resolveSourceDocuments: async () => [],
    }),
    prisma: null,
  });
  const result = await router.recall('What does this source say?', {
    mode: 'explain', source_document_id: 'not-authorized',
  }, { userId: 'user-1', orgId: 'org-1' });
  assert.equal(recalled, false);
  assert.deepEqual(result.memories, []);
  assert.equal(result.trace.cutoff_reason, 'source_not_found');
});

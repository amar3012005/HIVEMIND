import test from 'node:test';
import assert from 'node:assert/strict';
import { buildEvidencePacket, deliverHybrid, hop2Evidence, loadTypedGraphEvidence, projectInventoryAbsentIsAuthoritative, recallEnhance } from '../../src/memory/recall-router.js';
import { buildLexicalPhrases, EvidenceRetrievalService, fuseRemoteEvidenceHits, matchSourceDocuments } from '../../src/knowledge/evidence-retrieval.js';

test('lexical phrase planning is language-independent and preserves query order', () => {
  assert.deepEqual(buildLexicalPhrases(['alpha', 'beta', 'gamma', 'delta'], { max: 5 }), [
    'alpha beta gamma', 'beta gamma delta', 'alpha beta', 'beta gamma', 'gamma delta',
  ]);
});

test('remote evidence fusion preserves semantic and lexical provenance without flat lexical scores', () => {
  const fused = fuseRemoteEvidenceHits(
    [{ segment_id: 'relevant', score: 0.82 }, { segment_id: 'semantic-only', score: 0.71 }],
    [{ segment_id: 'relevant', score: 4.2 }, { segment_id: 'distractor', score: 1.1 }],
  );
  assert.equal(fused[0].segment_id, 'relevant');
  assert.equal(fused[0]._semantic, true);
  assert.equal(fused[0]._lexical, true);
  assert.equal(fused[0].semantic_score, 0.82);
  assert.equal(fused[0].lexical_score, 4.2);
  assert.ok(fused.every((row) => row.score !== 0.7));
});

test('unified delivery gives the fast reranker a bounded grace window after retrieval budget exhaustion', async () => {
  const started = Date.now();
  const delivered = await deliverHybrid({
    query: 'deadline-safe mixed recall',
    memories: [{ id: 'memory-1', content: 'memory fact' }],
    evidence: [{ segmentId: 'segment-1', content: 'source passage' }],
    deliverN: 5,
    evidenceN: 5,
    budgetMs: 1,
  });
  assert.ok(Date.now() - started < 250);
  assert.equal(delivered.ranking_mode, 'provider_failure_interleave');
  assert.equal(delivered.rerank_passes, 0);
  assert.equal(delivered.ranked_candidates.length, 2);
  assert.equal(delivered.evidence.length, 1);
  assert.equal(delivered.memories.length, 1);
});

test('remote explicit source validation accepts only the requested listed document', () => {
  const documents = [
    { document_id: 'doc-a', filename: 'Alpha Notes.pdf' },
    { id: 'doc-b', title: 'Beta Notes.pdf' },
  ];
  assert.deepEqual(matchSourceDocuments(documents, { documentId: 'doc-a' }), [{
    document_id: 'doc-a', filename: 'Alpha Notes.pdf', id: 'doc-a', title: 'Alpha Notes.pdf',
  }]);
  assert.equal(matchSourceDocuments(documents, { documentId: 'doc-missing' }).length, 0);
  assert.equal(matchSourceDocuments(documents, { title: 'beta notes' })[0].id, 'doc-b');
});

test('full evidence packet preserves a bounded raw source window', () => {
  const evidence = Array.from({ length: 20 }, (_, i) => ({
    segmentId: `s${i}`,
    documentId: `d${Math.floor(i / 5)}`,
    content: `section ${i}`,
    metadata: { segmentIndex: i },
  }));
  const packet = buildEvidencePacket({
    memories: [{ id: 'm1', title: 'Anchor' }],
    evidence,
    plan: { mode: 'full' },
  });
  assert.equal(packet.source_sections.length, 12);
  const counts = packet.source_sections.reduce((m, s) => m.set(s.document_id, (m.get(s.document_id) || 0) + 1), new Map());
  assert.ok([...counts.values()].every((count) => count <= 8));
  assert.equal(packet.citations.length, 12);
});

test('evidence packet prefers the query-centred snippet over a segment prefix', () => {
  const packet = buildEvidencePacket({
    memories: [],
    evidence: [{
      segmentId: 's1', documentId: 'd1',
      content: 'irrelevant segment prefix',
      snippet: '...never act on client data without human approval...',
    }],
    plan: { mode: 'explain' },
  });
  assert.match(packet.source_sections[0].content, /human approval/);
  assert.doesNotMatch(packet.source_sections[0].content, /irrelevant segment prefix/);
});

test('source-focused evidence admits only the resolved document id', async () => {
  const calls = [];
  const result = await hop2Evidence({
    evidenceService: {
      async retrieveEvidence(options) {
        calls.push(options);
        return [{ segmentId: 'segment-1', documentId: 'document-active' }];
      },
    },
    query: 'What does it say about human approval?',
    ctx: { userId: 'user-1', orgId: 'org-1' },
    inspection: { docIds: ['document-active'], filenames: [], sparse: true },
    prisma: null,
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].documentIds, ['document-active']);
  assert.equal(result.reason, 'doc-anchored');
  assert.deepEqual(result.docIds, ['document-active']);
});

test('project evidence intersects shared-tier memory anchors with project documents', async () => {
  const calls = [];
  const result = await hop2Evidence({
    evidenceService: {
      async retrieveEvidence(options) {
        calls.push(options);
        return [{ segmentId: 'segment-project', documentId: 'document-project' }];
      },
    },
    query: 'What does the selected project say?',
    ctx: { userId: 'user-1', orgId: 'org-1', projectId: 'project-1' },
    inspection: { docIds: ['document-personal'], filenames: [], sparse: false },
    prisma: {
      knowledgeDocument: {
        async findMany({ where }) {
          assert.equal(where.orgId, 'org-1');
          assert.deepEqual(where.tags, { has: 'scope-key:project:project-1' });
          return [{ id: 'document-project' }];
        },
      },
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].documentIds, ['document-project']);
  assert.equal(result.reason, 'project-corpus');
});

test('empty selected project does not widen evidence retrieval to the organization', async () => {
  let called = false;
  const result = await hop2Evidence({
    evidenceService: { async retrieveEvidence() { called = true; return []; } },
    query: 'Anything?',
    ctx: { userId: 'user-1', orgId: 'org-1', projectId: 'project-empty' },
    inspection: { docIds: ['document-personal'], filenames: [], sparse: true },
    prisma: { knowledgeDocument: { async findMany() { return []; } } },
  });

  assert.equal(called, false);
  assert.deepEqual(result, { items: [], reason: 'project-empty', docIds: [] });
});

test('only central storage treats a missing central project inventory as authoritative', () => {
  assert.equal(projectInventoryAbsentIsAuthoritative('central'), true);
  assert.equal(projectInventoryAbsentIsAuthoritative('amr-local'), false);
  assert.equal(projectInventoryAbsentIsAuthoritative('agent'), false);
});

test('evidence hydration re-applies the document allowlist in canonical storage', async () => {
  let hydrateWhere;
  const service = new EvidenceRetrievalService({
    db: {
      knowledgeSegment: {
        async findMany({ where }) {
          hydrateWhere = where;
          return [];
        },
      },
    },
    qdrantClient: {
      async searchMemories() {
        return [{ score: 0.9, payload: { segment_id: 'segment-candidate' } }];
      },
    },
  });

  await service.retrieveEvidence({
    query: 'selected project fact', userId: 'user-1', orgId: 'org-1',
    documentIds: ['document-project-a', 'document-project-b'],
    depth: 5, deliver: 5,
  });

  assert.deepEqual(hydrateWhere.documentId, {
    in: ['document-project-a', 'document-project-b'],
  });
});

test('central evidence returns tenant-scoped lexical results when vector search hangs', async () => {
  const previousVectorBudget = process.env.CENTRAL_EVIDENCE_VECTOR_BUDGET_MS;
  const previousLexicalBudget = process.env.CENTRAL_EVIDENCE_LEXICAL_BUDGET_MS;
  process.env.CENTRAL_EVIDENCE_VECTOR_BUDGET_MS = '20';
  process.env.CENTRAL_EVIDENCE_LEXICAL_BUDGET_MS = '20';
  const calls = [];
  const segment = {
    id: 'segment-lexical',
    documentId: 'document-allowed',
    content: 'LumenCore is the exact product identifier requested by the user.',
    segmentType: 'paragraph',
    segmentIndex: 0,
    wordCount: 10,
    startPage: 1,
    endPage: 1,
    metadata: {},
    document: {
      id: 'document-allowed', title: 'Product brief', documentType: 'markdown',
      sourcePlatform: 'upload', sourceUrl: null, documentDate: null,
      tags: ['scope-key:org:org-1'],
    },
  };
  const service = new EvidenceRetrievalService({
    db: {
      knowledgeSegment: {
        async findMany(args) {
          calls.push(args);
          if (args.where?.id?.in) return [];
          return [segment];
        },
      },
    },
    qdrantClient: {
      searchMemories() { return new Promise(() => {}); },
    },
  });

  try {
    const started = Date.now();
    const results = await service.retrieveEvidence({
      query: 'Welche Kapazitat hat LumenCore?',
      userId: 'user-1', orgId: 'org-1', documentIds: ['document-allowed'],
      depth: 5, deliver: 5,
    });
    assert.ok(Date.now() - started < 250);
    assert.equal(results[0].segmentId, 'segment-lexical');
    assert.equal(results[0]._lexical, true);
    assert.ok(calls.some(({ where }) => where.orgId === 'org-1'
      && where.documentId?.in?.includes('document-allowed')));
  } finally {
    if (previousVectorBudget === undefined) delete process.env.CENTRAL_EVIDENCE_VECTOR_BUDGET_MS;
    else process.env.CENTRAL_EVIDENCE_VECTOR_BUDGET_MS = previousVectorBudget;
    if (previousLexicalBudget === undefined) delete process.env.CENTRAL_EVIDENCE_LEXICAL_BUDGET_MS;
    else process.env.CENTRAL_EVIDENCE_LEXICAL_BUDGET_MS = previousLexicalBudget;
  }
});

test('source metadata resolution is tenant-scoped and does not require an LLM filename extraction', async () => {
  let where;
  const service = new EvidenceRetrievalService({
    db: {
      knowledgeDocument: {
        findMany: async (args) => {
          where = args.where;
          return [
            { id: 'brochure', title: 'HIVEMIND Brochure.html.pdf', sourceId: 'hivemind-brochure', updatedAt: new Date('2026-07-15') },
            { id: 'other', title: 'Other document', sourceId: 'other', updatedAt: new Date('2026-07-16') },
          ];
        },
      },
    },
    qdrantClient: null,
  });
  const documents = await service.resolveSourceFromQuery({
    userId: 'user-1', orgId: 'org-1', query: 'What exactly does HIVEMIND Brochure.html.pdf say?',
  });
  assert.equal(where.userId, 'user-1');
  assert.equal(where.orgId, 'org-1');
  assert.equal(where.archivedAt, null);
  assert.deepEqual(documents.map((document) => document.id), ['brochure']);
  assert.equal(documents[0]._sourceMatch, 'filename');
});

test('source metadata resolution rejects a weak one-token coincidence', async () => {
  const service = new EvidenceRetrievalService({
    db: {
      knowledgeDocument: {
        findMany: async () => [{
          id: 'policy',
          title: 'General approval policy.pdf',
          sourceId: 'general-approval-policy-pdf',
          updatedAt: new Date('2026-07-16'),
        }],
      },
    },
    qdrantClient: null,
  });
  const documents = await service.resolveSourceFromQuery({
    userId: 'user-1',
    orgId: 'org-1',
    query: 'What is the approval workflow for this project today?',
  });
  assert.deepEqual(documents, []);
});

test('packet preserves partial results and exposes latency cutoff', () => {
  const packet = buildEvidencePacket({
    memories: [{ id: 'm1', content: 'fast fact' }],
    graph: [{ type: 'Contradicts', from_id: 'm1', to_id: 'm2' }],
    plan: { mode: 'explain' },
    cutoffReason: 'latency_budget',
  });
  assert.equal(packet.facts[0].content, 'fast fact');
  assert.equal(packet.conflicts.length, 1);
  assert.equal(packet.cutoff_reason, 'latency_budget');
});

test('typed graph expansion rejects inaccessible tenant scopes', async () => {
  const rows = [
    edge('organization', 'organization'),
    edge('personal', 'personal', { toUserId: 'other-user' }),
    edge('project', 'project', { projectId: 'other-project' }),
    edge('project', 'project', { projectId: 'allowed-project', suffix: 'allowed' }),
  ];
  let where;
  const prisma = { relationship: { findMany: async (args) => { where = args.where; return rows; } } };
  const result = await loadTypedGraphEvidence({
    prisma,
    memoryIds: ['anchor'],
    userId: 'user-1',
    orgId: 'org-1',
    accessContext: { projectIds: ['allowed-project'], teamIds: [] },
  });
  assert.equal(where.fromMemory.orgId, 'org-1');
  assert.equal(where.toMemory.orgId, 'org-1');
  assert.equal(result.items.length, 2);
  assert.ok(result.items.some((item) => item.to_id === 'to-allowed'));
});

test('valid-time graph expansion keeps lifecycle edges while known-time remains bounded', async () => {
  let where;
  const prisma = { relationship: { findMany: async (args) => { where = args.where; return [edge('personal', 'personal')]; } } };
  const knownAt = '2026-02-01T00:00:00.000Z';
  const result = await loadTypedGraphEvidence({
    prisma,
    memoryIds: ['anchor'],
    userId: 'user-1',
    orgId: 'org-1',
    accessContext: { projectIds: [], teamIds: [] },
    time: { valid_at: '2026-01-01T00:00:00.000Z', known_at: knownAt },
  });
  assert.equal(where.createdAt.lte.toISOString(), knownAt);
  assert.equal(where.fromMemory.createdAt.lte.toISOString(), knownAt);
  assert.equal(where.fromMemory.AND, undefined);
  assert.equal(result.items.length, 1);
});

test('hung event-driven evidence returns at the deadline for fast fallback', async () => {
  const started = Date.now();
  const enhanced = await recallEnhance({
    memories: [],
    query: 'deadline test',
    ctx: { userId: 'user-1', orgId: 'org-1' },
    evidenceService: { retrieveEvidence: () => new Promise(() => {}) },
    prisma: null,
    includeLive: false,
    deadlineMs: 25,
  });
  assert.equal(enhanced.trace.evidence_trigger, 'timeout');
  assert.deepEqual(enhanced.evidence, []);
  assert.ok(Date.now() - started < 200);
});

test('hung live connector returns at the deadline with an empty live fallback', async () => {
  const started = Date.now();
  const enhanced = await recallEnhance({
    memories: [{ id: 'm1', tags: ['source:gmail'] }],
    query: 'latest gmail message',
    ctx: { userId: 'user-1', orgId: 'org-1' },
    evidenceService: null,
    prisma: {},
    includeLive: true,
    liveIntent: true,
    deadlineMs: 25,
    liveQuery: () => new Promise(() => {}),
  });
  assert.equal(enhanced.trace.live_eligible, true);
  assert.equal(enhanced.trace.live_trigger, 'timeout');
  assert.deepEqual(enhanced.live, []);
  assert.ok(Date.now() - started < 200);
});

test('full recall hydrates a tenant-scoped ordered source window', async () => {
  let query;
  const service = new EvidenceRetrievalService({
    db: {
      knowledgeSegment: {
        findMany: async (args) => {
          query = args;
          return [2, 3, 4].map((segmentIndex) => ({
            id: `s${segmentIndex}`,
            documentId: 'doc-1',
            content: `section ${segmentIndex}`,
            segmentType: 'paragraph',
            segmentIndex,
            wordCount: 2,
            startPage: 1,
            endPage: 1,
            document: { id: 'doc-1', title: 'Source' },
          }));
        },
      },
    },
    qdrantClient: null,
  });
  const result = await service.hydrateAdjacentEvidence({
    anchors: [{ documentId: 'doc-1', score: 0.9, metadata: { segmentIndex: 3 } }],
    userId: 'user-1',
    orgId: 'org-1',
  });
  assert.equal(query.where.userId, 'user-1');
  assert.equal(query.where.orgId, 'org-1');
  assert.deepEqual(query.where.OR[0], { documentId: 'doc-1', segmentIndex: { gte: 2, lte: 4 } });
  assert.deepEqual(result.map((item) => item.metadata.segmentIndex), [2, 3, 4]);
});

test('full recall keeps matched evidence when adjacent hydration exceeds its deadline', async () => {
  const enhanced = await recallEnhance({
    memories: [{ id: 'm1', tags: ['doc-id:doc-1'] }],
    query: 'source context',
    ctx: { userId: 'user-1', orgId: 'org-1' },
    evidenceService: {
      retrieveEvidence: async () => [{ segmentId: 's1', documentId: 'doc-1', content: 'matched', metadata: { segmentIndex: 1 } }],
      hydrateAdjacentEvidence: () => new Promise(() => {}),
    },
    prisma: null,
    includeLive: false,
    includeAdjacent: true,
    deadlineMs: 25,
  });
  assert.equal(enhanced.trace.adjacent_trigger, 'timeout');
  assert.equal(enhanced.evidence[0].content, 'matched');
});

test('named source resolution is tenant scoped', async () => {
  let query;
  const service = new EvidenceRetrievalService({
    db: {
      knowledgeDocument: {
        findMany: async (args) => { query = args; return [{ id: 'doc-1', title: 'Board Notes.pdf' }]; },
      },
    },
    qdrantClient: null,
  });
  const documents = await service.resolveSourceDocuments({
    userId: 'user-1', orgId: 'org-1', title: 'Board Notes',
  });
  assert.equal(query.where.userId, 'user-1');
  assert.equal(query.where.orgId, 'org-1');
  assert.equal(query.where.archivedAt, null);
  assert.equal(query.where.OR.length, 2);
  assert.equal(documents[0].id, 'doc-1');
});

test('named source hydration returns ordered raw segments around evidence anchor', async () => {
  let segmentQuery;
  const service = new EvidenceRetrievalService({
    db: {
      knowledgeSegment: {
        findMany: async (args) => {
          segmentQuery = args;
          return [3, 4].map((segmentIndex) => ({
            id: `s${segmentIndex}`, documentId: 'doc-1', content: `raw ${segmentIndex}`,
            segmentType: 'paragraph', segmentIndex, wordCount: 2,
          }));
        },
      },
    },
    qdrantClient: null,
  });
  service.retrieveEvidence = async () => [{
    segmentId: 's4', documentId: 'doc-1', score: 0.9, metadata: { segmentIndex: 4 },
  }];
  const rows = await service.hydrateSourceDocuments({
    documents: [{ id: 'doc-1', title: 'Board Notes.pdf' }],
    query: 'budget decision', userId: 'user-1', orgId: 'org-1', perDocument: 4, total: 4,
  });
  assert.deepEqual(segmentQuery.where, {
    userId: 'user-1', orgId: 'org-1', documentId: 'doc-1',
    document: { archivedAt: null }, segmentIndex: { in: [3, 4, 5] },
  });
  assert.deepEqual(rows.map((row) => row.metadata.segmentIndex), [3, 4]);
  assert.equal(rows[0].document.title, 'Board Notes.pdf');
});

test('named source hydration keeps a query-centred passage for the answer model', async () => {
  const content = `${'prefix '.repeat(150)}never act on client data without human approval. Lawyers review the output.`;
  const service = new EvidenceRetrievalService({
    db: {
      knowledgeSegment: {
        findMany: async () => [{ id: 's1', documentId: 'doc-1', content, segmentIndex: 1 }],
      },
    },
    qdrantClient: null,
  });
  service.retrieveEvidence = async () => [{
    segmentId: 's1', documentId: 'doc-1', score: 0.9, metadata: { segmentIndex: 1 },
  }];
  const [row] = await service.hydrateSourceDocuments({
    documents: [{ id: 'doc-1', title: 'Brochure.pdf' }],
    query: 'human approval', userId: 'user-1', orgId: 'org-1',
  });
  assert.match(row.snippet, /human approval/);
  assert.ok(row.snippet.length <= 526);
});

test('query-centred snippets prefer the window covering the most lowercase query detail', () => {
  const service = new EvidenceRetrievalService({ db: null, qdrantClient: null });
  const content = `This brochure is an overview. ${'padding '.repeat(30)}Any action on client data requires human approval before execution.`;
  const snippet = service._extractSnippet(content, 'what does the brochure say about human approval', 120);
  assert.match(snippet, /human approval/);
  assert.doesNotMatch(snippet, /^This brochure is an overview/);
});

test('named source hydration falls back to canonical segments when vector search hangs', async () => {
  const service = new EvidenceRetrievalService({
    db: { knowledgeSegment: { findMany: async () => [{ id: 's0', documentId: 'doc-1', content: 'raw', segmentIndex: 0 }] } },
    qdrantClient: null,
  });
  service.retrieveEvidence = () => new Promise(() => {});
  const started = Date.now();
  const rows = await service.hydrateSourceDocuments({
    documents: [{ id: 'doc-1', title: 'Source' }], query: 'query', userId: 'u', orgId: 'o',
  });
  assert.equal(rows.length, 1);
  assert.ok(Date.now() - started < 800);
});

function edge(fromScope, toScope, { toUserId = 'user-1', projectId = null, suffix = 'base' } = {}) {
  const memory = (id, scope, userId) => ({
    id, scope, userId, title: id, content: id, projectId,
    primaryTeamId: null, isLatest: true,
    memoryProjects: projectId ? [{ projectId }] : [],
  });
  return {
    fromId: 'anchor', toId: `to-${suffix}`, type: 'Extends', confidence: 0.9,
    metadata: {}, createdAt: new Date(),
    fromMemory: memory('anchor', fromScope, 'user-1'),
    toMemory: memory(`to-${suffix}`, toScope, toUserId),
  };
}

import test from 'node:test';
import assert from 'node:assert/strict';
import { EvidenceRetrievalService, filterEvidenceByMetadata } from '../../src/knowledge/evidence-retrieval.js';

const evidence = [
  {
    id: 'e-old', content: 'Kruti approved the old pricing decision',
    document: { title: 'Board Notes.pdf' },
    metadata: {
      entities: ['Kruti'], memory_type: 'decision', source_kind: 'kb',
      source_title: 'Board Notes.pdf', known_at: '2026-08-20T00:00:00Z',
      linked_memory_ids: ['m-old'],
    },
  },
  {
    id: 'e-new', content: 'Kruti approved the current pricing decision',
    document: { title: 'Board Notes.pdf' },
    metadata: {
      entities: ['Kruti'], memory_type: 'decision', source_kind: 'kb',
      source_title: 'Board Notes.pdf', known_at: '2026-08-25T00:00:00Z',
      linked_memory_ids: ['m-new'],
    },
  },
  {
    id: 'e-wrong-entity', content: 'Other person approved a pricing decision',
    document: { title: 'Board Notes.pdf' },
    metadata: {
      entities: ['Other'], memory_type: 'decision', source_kind: 'kb',
      source_title: 'Board Notes.pdf', known_at: '2026-08-26T00:00:00Z',
      linked_memory_ids: ['m-new'],
    },
  },
];

test('evidence applies entity, type, source and relationship predicates symmetrically', () => {
  const rows = filterEvidenceByMetadata(evidence, {
    entities: ['Kruti'], memoryTypes: ['decision'], sourceKind: 'kb',
    sourceTitle: 'Board Notes.pdf', relationshipMemoryIds: ['m-new'],
  });
  assert.deepEqual(rows.map((row) => row.id), ['e-new']);
});

test('evidence latest is chronological after hard predicates, not semantic score order', () => {
  evidence[0].score = 0.99;
  evidence[1].score = 0.10;
  const rows = filterEvidenceByMetadata(evidence, {
    entities: ['Kruti'], memoryTypes: ['decision'], sourceTitle: 'Board Notes.pdf',
    temporalSelector: 'latest', time: { axis: 'known_time' },
  });
  assert.deepEqual(rows.map((row) => row.id), ['e-new', 'e-old']);
});

test('relationship predicates fail closed and never accept inferred document lineage', () => {
  const inferred = [{
    ...evidence[1], linked_memory_id: 'm-new', _lineage_inferred: true,
    metadata: { ...evidence[1].metadata, linked_memory_ids: [] },
  }];
  assert.deepEqual(filterEvidenceByMetadata(inferred, {
    relationshipRequired: true, relationshipMemoryIds: [],
  }), []);
  assert.deepEqual(filterEvidenceByMetadata(inferred, {
    relationshipRequired: true, relationshipMemoryIds: ['m-new'],
  }), []);
});

test('organization evidence fails closed for guest memberships in explicit and default views', () => {
  const service = new EvidenceRetrievalService({ db: {}, qdrantClient: {} });
  const explicit = service._accessibleDocumentWhere({
    userId: 'guest-1', orgId: 'org-1', accessContext: { orgRole: 'guest' },
    scopeFilter: 'organization',
  });
  assert.deepEqual(explicit.id, { in: [] });

  const combined = service._accessibleDocumentWhere({
    userId: 'guest-1', orgId: 'org-1', accessContext: { orgRole: 'guest', projectIds: [] },
  });
  assert.equal(combined.OR.some((arm) => arm.tags?.hasSome?.includes('scope-key:org:org-1')), false);
});

test('caller-supplied document IDs are intersected with the authorized document set', async () => {
  let documentWhere = null;
  const service = new EvidenceRetrievalService({
    db: {
      knowledgeDocument: {
        findMany: async ({ where }) => { documentWhere = where; return []; },
      },
    },
    qdrantClient: {
      generateEmbedding: async () => { throw new Error('embedding must not run for a forbidden document'); },
    },
  });
  const rows = await service.retrieveEvidence({
    query: 'private policy', userId: 'user-1', orgId: 'org-1',
    documentId: 'private-doc', accessContext: { orgRole: 'member', projectIds: [], teamIds: [] },
  });
  assert.deepEqual(rows, []);
  assert.deepEqual(documentWhere.AND[1], { id: { in: ['private-doc'] } });
  assert.ok(documentWhere.AND[0].OR);
});

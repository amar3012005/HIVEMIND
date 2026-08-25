import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentFirstIngestionService,
  normalizeCuratedClaims,
  promotionProvenance,
} from '../../src/knowledge/document-first-ingestion.js';

test('promotion retains complete persisted evidence provenance', () => {
  const provenance = promotionProvenance({
    id: '55555555-5555-4555-8555-555555555555', startPage: 7,
    metadata: {
      source_id: 'uploaded:report-v3', source_title: 'Annual report', source_kind: 'pdf',
      citation_id: 'cite:annual-report:7', scope: 'project', project_ids: ['project-1'],
      primary_team_id: 'team-1', document_date: '2026-01-20T00:00:00.000Z',
      known_at: '2026-02-01T00:00:00.000Z', embedding_model: 'bge-m3', content_hash: 'abc',
    },
  }, '33333333-3333-4333-8333-333333333333', { filename: 'annual.pdf' });

  assert.equal(provenance.document_id, '33333333-3333-4333-8333-333333333333');
  assert.equal(provenance.segment_id, '55555555-5555-4555-8555-555555555555');
  assert.equal(provenance.citation_id, 'cite:annual-report:7');
  assert.equal(provenance.scope, 'project');
  assert.deepEqual(provenance.project_ids, ['project-1']);
  assert.equal(provenance.primary_team_id, 'team-1');
  assert.equal(provenance.document_date, '2026-01-20T00:00:00.000Z');
  assert.equal(provenance.known_at, '2026-02-01T00:00:00.000Z');
  assert.equal(provenance.embedding_model, 'bge-m3');
});

test('stored evidence promotion generates memories without invoking extraction and advances document mode', async () => {
  const documentId = '33333333-3333-4333-8333-333333333333';
  const updates = [];
  const service = new DocumentFirstIngestionService({
    db: {
      knowledgeDocument: {
        findFirst: async () => ({
          id: documentId, userId: '11111111-1111-4111-8111-111111111111', ingestMode: 'evidence',
          title: 'Evidence report', documentType: 'file', sourcePlatform: 'knowledge_upload',
          sourceId: 'report-source', sourceUrl: null, documentDate: new Date('2026-01-20T00:00:00.000Z'),
          tags: ['scope-key:org'], parseMetadata: { scope: 'organization', citation_id: 'DOC-1:S-1' },
          segments: [{
            id: '55555555-5555-4555-8555-555555555555', content: 'The verified launch date is 14 September 2028.',
            segmentIndex: 0, segmentType: 'chunk', metadata: { citation_id: 'DOC-1:S-1', scope: 'organization' },
          }],
        }),
        update: async (input) => { updates.push(input); return input; },
      },
    },
    memoryGraphEngine: {}, smartIngestRouter: null, embeddingService: null,
    logger: { info() {}, warn() {}, error() {} },
  });
  let extracted = false;
  service._parseDocument = async () => { extracted = true; throw new Error('must not parse'); };
  service._promoteMemories = async (input) => {
    assert.equal(input.documentId, documentId);
    assert.equal(input.metadata.ingest_mode, 'both');
    assert.equal(input.metadata.original_ingest_mode, 'evidence');
    assert.equal(input.segments.length, 1);
    return { candidates: [{ segmentId: input.segments[0].id }], memories: [{ id: '66666666-6666-4666-8666-666666666666' }] };
  };

  const result = await service.promoteStoredEvidence({
    documentId,
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
  });

  assert.equal(extracted, false);
  assert.equal(result.promotionMode, 'from_existing_evidence');
  assert.equal(result.promotedCount, 1);
  assert.deepEqual(result.promotedMemoryIds, ['66666666-6666-4666-8666-666666666666']);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.ingestMode, 'both');
  assert.equal(updates[0].data.parseMetadata.original_ingest_mode, 'evidence');
});

test('promoted memories retain stored evidence provenance in memory and vector writes', async () => {
  const documentId = '33333333-3333-4333-8333-333333333333';
  const segmentId = '55555555-5555-4555-8555-555555555555';
  const memoryWrites = [];
  const vectorWrites = [];
  const evidenceLinks = [];
  const service = new DocumentFirstIngestionService({
    db: {
      knowledgeSegment: { findMany: async () => [], update: async () => ({}) },
      memoryEvidenceLink: { createMany: async ({ data }) => evidenceLinks.push(...data) },
      memoryDerivation: { createMany: async () => ({}) },
    },
    memoryGraphEngine: {
      ingestMemory: async (payload) => {
        memoryWrites.push(payload);
        return { memoryId: '66666666-6666-4666-8666-666666666666' };
      },
      store: { createRelationship: async () => ({}) },
      vectorStore: {
        generateEmbeddings: async () => [Array(1024).fill(0.1)],
        storeMemory: async (payload) => vectorWrites.push(payload),
      },
    },
    smartIngestRouter: null, embeddingService: null,
    logger: { info() {}, warn() {}, error() {} },
  });
  const segment = {
    id: segmentId,
    startPage: 7,
    metadata: {
      source_id: 'stored-source', source_title: 'Stored evidence title', source_kind: 'pdf',
      citation_id: 'cite:annual-report:7', scope: 'project', project_ids: ['project-1'],
      primary_team_id: 'team-1', document_date: '2026-01-20T00:00:00.000Z',
      known_at: '2026-02-01T00:00:00.000Z', event_time: '2026-02-03T00:00:00.000Z',
      uploaded_by_user_id: 'evidence-uploader', content_hash: 'evidence-hash',
      embedding_model: 'bge-m3', embedding_version: '7',
    },
  };
  const provenance = promotionProvenance(segment, documentId, {
    filename: 'annual.pdf', scope: 'organization', document_date: '2026-03-01T00:00:00.000Z',
  });

  await service._ingestUnifiedWindow({
    segmentId,
    content: 'The verified launch date is 14 September 2028.',
  }, {
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    documentId,
    metadata: { filename: 'annual.pdf', scope: 'organization', visibility: 'organization' },
    docTitle: 'Annual report',
    evidenceProvenance: provenance,
    supportingEvidenceProvenance: [provenance],
    preExtractedFacts: [{
      t: 'Launch date', f: 'The verified launch date is 14 September 2028.',
      memory_type: 'fact', claim_kind: 'event', importance: 0.9,
      source_quote: 'The verified launch date is 14 September 2028.',
      source_start: 0, source_end: 47, entities: [], rels: [],
      segmentId, support_segment_ids: [segmentId],
      support_quotes: ['The verified launch date is 14 September 2028.'],
    }],
  });

  assert.equal(memoryWrites.length, 1);
  assert.equal(vectorWrites.length, 1);
  assert.equal(memoryWrites[0].scope, 'project');
  assert.deepEqual(memoryWrites[0].project_ids, ['project-1']);
  assert.equal(memoryWrites[0].primary_team_id, 'team-1');
  for (const provenancePayload of [
    memoryWrites[0].source_metadata,
    memoryWrites[0].metadata,
    vectorWrites[0].source_metadata,
    vectorWrites[0].metadata,
  ]) {
    assert.equal(provenancePayload.document_id, documentId);
    assert.equal(provenancePayload.segment_id, segmentId);
    assert.equal(provenancePayload.source_id, 'stored-source');
    assert.equal(provenancePayload.source_title, 'Stored evidence title');
    assert.equal(provenancePayload.citation_id, 'cite:annual-report:7');
    assert.equal(provenancePayload.scope, 'project');
    assert.equal(provenancePayload.uploaded_by_user_id, 'evidence-uploader');
    assert.equal(provenancePayload.document_date, '2026-01-20T00:00:00.000Z');
    assert.equal(provenancePayload.known_at, '2026-02-01T00:00:00.000Z');
    assert.equal(provenancePayload.source_content_hash, 'evidence-hash');
    assert.equal(provenancePayload.embedding_model, 'bge-m3');
    assert.equal(provenancePayload.supporting_evidence[0].citation_id, 'cite:annual-report:7');
  }
  assert.deepEqual(evidenceLinks.map((link) => link.segmentId), [segmentId]);
});

test('default promotion curation caps atomic memories at fourteen', async () => {
  const caps = [];
  const service = new DocumentFirstIngestionService({
    db: {}, memoryGraphEngine: { vectorStore: null }, smartIngestRouter: null, embeddingService: null,
    logger: { info() {}, warn() {}, error() {} },
  });
  service._extractUnifiedReliable = async () => Array.from({ length: 20 }, (_, index) => ({
    t: `Fact ${index}`, f: `A durable fact ${index}.`, memory_type: 'fact', claim_kind: 'fact',
    importance: 0.9, source_quote: `A durable fact ${index}.`, entities: [], rels: [],
  }));
  service._curateDocumentClaims = async (_candidates, options) => {
    caps.push(options.maxMemories);
    return [];
  };
  service._attachDocumentParent = async () => null;
  const previousConcurrency = process.env.KB_UNIFIED_CONCURRENCY;
  process.env.KB_UNIFIED_CONCURRENCY = '1';
  let result;
  try {
    result = await service._promoteMemories({
      documentId: '33333333-3333-4333-8333-333333333333',
      userId: '11111111-1111-4111-8111-111111111111',
      orgId: '22222222-2222-4222-8222-222222222222',
      metadata: { filename: 'dense.txt', scope: 'organization' },
      segments: [{
        id: '55555555-5555-4555-8555-555555555555',
        content: 'A durable source sentence. '.repeat(400), metadata: {},
      }],
    });
  } finally {
    if (previousConcurrency === undefined) delete process.env.KB_UNIFIED_CONCURRENCY;
    else process.env.KB_UNIFIED_CONCURRENCY = previousConcurrency;
  }
  assert.deepEqual(caps, [14]);
  assert.equal(result.candidates.length, 180, 'candidate count reports grounded extracted claims, not input windows');
  assert.equal(result.memories.length, 0);
  assert.equal(result.coverage.promotion_failed, true, 'zero-yield both-mode promotion is an explicit failure state');
});

test('one document parent completes a fourteen-memory promotion and keeps child provenance', async () => {
  const parentWrites = [];
  const relationships = [];
  const summaryLinks = [];
  const documentId = '33333333-3333-4333-8333-333333333333';
  const memories = Array.from({ length: 14 }, (_, index) => ({
    id: `memory-${index}`,
    title: `Fact ${index}`,
    support_segment_ids: [`segment-${index}`],
    source_metadata: {
      evidence_provenance: {
        segment_id: `segment-${index}`,
        document_id: documentId,
        source_id: 'stored-source',
        source_title: 'Stored evidence title',
        citation_id: `cite:${index}`,
        scope: 'organization',
        uploaded_by_user_id: 'evidence-uploader',
        document_date: '2026-01-20T00:00:00.000Z',
        known_at: '2026-02-01T00:00:00.000Z',
      },
    },
  }));
  const service = new DocumentFirstIngestionService({
    db: { memoryEvidenceLink: { createMany: async ({ data }) => summaryLinks.push(...data) } },
    memoryGraphEngine: {
      ingestMemory: async (payload) => {
        parentWrites.push(payload);
        return { memoryId: 'parent-1' };
      },
      store: { createRelationship: async (edge) => relationships.push(edge) },
    },
    smartIngestRouter: null, embeddingService: null,
    logger: { info() {}, warn() {}, error() {} },
  });

  const parentId = await service._attachDocumentParent({
    memories,
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    documentId,
    metadata: { filename: 'annual.pdf', scope: 'organization' },
    totalFacts: 14,
  });

  assert.equal(parentId, 'parent-1');
  assert.equal(parentWrites.length, 1);
  assert.equal(parentWrites[0].memory_type, 'summary');
  assert.equal(memories.length, 15);
  assert.equal(relationships.length, 14);
  assert.equal(summaryLinks.length, 14);
  assert.equal(parentWrites[0].source_metadata.citation_id, 'cite:0');
  assert.equal(parentWrites[0].source_metadata.supporting_evidence.length, 14);
  assert.equal(parentWrites[0].source_metadata.supporting_evidence[13].citation_id, 'cite:13');
});

test('relationship labels remain graph edges and cannot be promoted as memories', () => {
  const candidates = [{
    t: 'Launch', f: 'Launch is 15 July.', memory_type: 'event', importance: 0.9,
    entities: [], segmentId: 'segment-1', source_quote: 'Launch is 15 July.',
  }];
  assert.deepEqual(normalizeCuratedClaims([{
    title: 'Relationship', content: 'A relationship row.', memory_type: 'relationship',
    importance: 1, support_indices: [0], entities: [],
  }], candidates, 8), []);
});

test('intentional evidence ingest stops after hybrid indexing and never calls memory generation', async () => {
  const calls = [];
  const documentId = '33333333-3333-4333-8333-333333333333';
  const db = {
    sourceArtifact: {
      upsert: async () => ({ id: '44444444-4444-4444-8444-444444444444', payload: {} }),
      update: async () => ({ id: '44444444-4444-4444-8444-444444444444' }),
    },
    knowledgeDocument: {
      findFirst: async () => null,
      upsert: async ({ create }) => {
        calls.push(['document', create.ingestMode]);
        return { id: documentId };
      },
    },
    knowledgeSegment: {
      findMany: async () => [],
      count: async () => 1,
    },
    memoryEvidenceLink: { count: async () => 0 },
  };
  const service = new DocumentFirstIngestionService({
    db,
    memoryGraphEngine: { ingestMemory: async () => { throw new Error('memory generation called'); } },
    smartIngestRouter: null,
    embeddingService: null,
    logger: { info() {}, warn() {}, error() {} },
  });
  service._parseDocument = async () => ({
    success: true,
    text: 'The Atlas launch date is 14 September 2028.',
    markdown: '# Atlas\nThe Atlas launch date is 14 September 2028.',
    wordCount: 9,
    pages: 1,
    engine: 'test-parser',
    metadata: { pages: 1 },
    tables: [],
  });
  service._createSegments = async () => [{
    id: '55555555-5555-4555-8555-555555555555',
    documentId,
    content: 'The Atlas launch date is 14 September 2028.',
    segmentIndex: 0,
    startPage: 1,
    metadata: {},
  }];
  service._embedSegments = async () => {
    calls.push(['hybrid-index']);
    return { total: 1, embedded: 1, failed: 0, healed: 0 };
  };
  service._promoteMemoriesGuarded = async () => {
    calls.push(['promotion']);
    throw new Error('promotion must not run');
  };
  service._extractPromotedEntitiesAsync = () => calls.push(['entities']);
  service._structureClaimsAsync = () => calls.push(['claims']);

  const oldSkip = process.env.KB_SKIP_UNCHANGED;
  process.env.KB_SKIP_UNCHANGED = '0';
  try {
    const result = await service.ingestKnowledgeDocument({
      userId: '11111111-1111-4111-8111-111111111111',
      orgId: '22222222-2222-4222-8222-222222222222',
      filename: 'atlas.txt',
      fileBuffer: Buffer.from('The Atlas launch date is 14 September 2028.'),
      contentType: 'text/plain',
      metadata: { scope: 'organization', document_type: 'general', ingest_mode: 'evidence' },
    });

    assert.equal(result.documentId, documentId);
    assert.equal(result.segmentCount, 1);
    assert.equal(result.promotedCount, 0);
    assert.deepEqual(result.promotedMemoryIds, []);
    assert.equal(result.evidenceOnlyReason, 'user_selected');
    assert.deepEqual(result.coverage.evidence_lexical, { total: 1, indexed: 1, failed: 0 });
    assert.deepEqual(calls, [['document', 'evidence'], ['hybrid-index']]);
  } finally {
    if (oldSkip === undefined) delete process.env.KB_SKIP_UNCHANGED;
    else process.env.KB_SKIP_UNCHANGED = oldSkip;
  }
});

test('parser output is sanitized before document metadata and segment creation', async () => {
  const captured = {};
  const db = {
    sourceArtifact: {
      upsert: async () => ({ id: '44444444-4444-4444-8444-444444444444', payload: {} }),
      update: async () => ({}),
    },
    knowledgeDocument: {
      findFirst: async () => null,
      upsert: async ({ create }) => {
        captured.document = create;
        return { id: '33333333-3333-4333-8333-333333333333' };
      },
    },
    knowledgeSegment: { findMany: async () => [], count: async () => 1 },
    memoryEvidenceLink: { count: async () => 0 },
  };
  const service = new DocumentFirstIngestionService({
    db, memoryGraphEngine: {}, smartIngestRouter: null, embeddingService: null,
    logger: { info() {}, warn() {}, error() {} },
  });
  service._parseDocument = async () => ({
    success: true,
    text: 'Atlas\u0000 launch',
    markdown: '# Atlas\u0000\nLaunch',
    wordCount: 2,
    pages: 1,
    engine: 'test-parser',
    metadata: { nested: { citation_id: 'cite\u0000-1' } },
    tables: [],
  });
  service._createSegments = async (input) => {
    captured.parse = input.parseResult;
    captured.scope = input.docScope;
    return [{
      id: '55555555-5555-4555-8555-555555555555',
      content: 'Atlas launch', segmentIndex: 0, startPage: 1, metadata: {},
    }];
  };
  service._embedSegments = async () => ({ total: 1, embedded: 1, failed: 0, healed: 0 });
  service._promoteMemoriesGuarded = async () => { throw new Error('promotion must not run'); };

  const oldSkip = process.env.KB_SKIP_UNCHANGED;
  process.env.KB_SKIP_UNCHANGED = '0';
  try {
    await service.ingestKnowledgeDocument({
      userId: '11111111-1111-4111-8111-111111111111',
      orgId: '22222222-2222-4222-8222-222222222222',
      filename: 'atlas.txt', fileBuffer: Buffer.from('Atlas launch'), contentType: 'text/plain',
      metadata: { ingest_mode: 'evidence', scope: 'organization', nested: { label: 'safe\u0000label' } },
    });
  } finally {
    if (oldSkip === undefined) delete process.env.KB_SKIP_UNCHANGED;
    else process.env.KB_SKIP_UNCHANGED = oldSkip;
  }

  assert.equal(captured.parse.text.includes('\u0000'), false);
  assert.equal(captured.parse.metadata.nested.citation_id, 'cite-1');
  assert.equal(captured.document.parseMetadata.nested.citation_id, 'cite-1');
  assert.equal(captured.scope.scope, 'organization');
});

test('intentional evidence ingest fails closed when semantic indexing is incomplete', async () => {
  const db = {
    sourceArtifact: {
      upsert: async () => ({ id: '44444444-4444-4444-8444-444444444444', payload: {} }),
      update: async () => ({}),
    },
    knowledgeDocument: { findFirst: async () => null, upsert: async () => ({ id: '33333333-3333-4333-8333-333333333333' }) },
    knowledgeSegment: { findMany: async () => [], count: async () => 0 },
    memoryEvidenceLink: { count: async () => 0 },
  };
  const service = new DocumentFirstIngestionService({
    db, memoryGraphEngine: {}, smartIngestRouter: null, embeddingService: null,
    logger: { info() {}, warn() {}, error() {} },
  });
  service._parseDocument = async () => ({
    success: true, text: 'Evidence text.', markdown: 'Evidence text.', wordCount: 2,
    pages: 1, engine: 'test-parser', metadata: { pages: 1 }, tables: [],
  });
  service._createSegments = async () => [{
    id: '55555555-5555-4555-8555-555555555555', content: 'Evidence text.', segmentIndex: 0, metadata: {},
  }];
  service._embedSegments = async () => ({ total: 1, embedded: 0, failed: 1, healed: 0 });
  service._promoteMemoriesGuarded = async () => { throw new Error('promotion must not run'); };

  const oldSkip = process.env.KB_SKIP_UNCHANGED;
  process.env.KB_SKIP_UNCHANGED = '0';
  try {
    await assert.rejects(service.ingestKnowledgeDocument({
      userId: '11111111-1111-4111-8111-111111111111',
      orgId: '22222222-2222-4222-8222-222222222222',
      filename: 'incomplete.txt', fileBuffer: Buffer.from('Evidence text.'), contentType: 'text/plain',
      metadata: { scope: 'organization', document_type: 'general', ingest_mode: 'evidence' },
    }), (error) => error?.code === 'EVIDENCE_INDEX_INCOMPLETE');
  } finally {
    if (oldSkip === undefined) delete process.env.KB_SKIP_UNCHANGED;
    else process.env.KB_SKIP_UNCHANGED = oldSkip;
  }
});

test('central vector batch failure is never marked stored or reported embedded', async () => {
  const updated = [];
  const service = new DocumentFirstIngestionService({
    db: { knowledgeSegment: { updateMany: async (query) => updated.push(query) } },
    memoryGraphEngine: {}, smartIngestRouter: null,
    embeddingService: {
      embed: async () => Array(1024).fill(0.1),
      storeVectors: async () => { throw new Error('qdrant unavailable'); },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  const coverage = await service._embedSegments([{
    id: '55555555-5555-4555-8555-555555555555',
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    documentId: '33333333-3333-4333-8333-333333333333',
    content: 'Evidence text.', contentHash: 'hash', segmentType: 'paragraph', segmentIndex: 0,
  }], '22222222-2222-4222-8222-222222222222');

  assert.deepEqual(coverage, { total: 1, embedded: 0, failed: 1, healed: 0 });
  assert.deepEqual(updated, []);
});

test('large evidence embedding uses provider batches of at most twenty and one vector upsert', async () => {
  const embedBatchSizes = [];
  const stored = [];
  const updated = [];
  const service = new DocumentFirstIngestionService({
    db: { knowledgeSegment: { updateMany: async (query) => updated.push(query) } },
    memoryGraphEngine: {}, smartIngestRouter: null,
    embeddingService: {
      embed: async (input) => {
        const rows = Array.isArray(input) ? input : [input];
        embedBatchSizes.push(rows.length);
        const vectors = rows.map(() => Array(1024).fill(0.1));
        return Array.isArray(input) ? vectors : vectors[0];
      },
      storeVectors: async ({ points }) => stored.push(...points),
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  const segments = Array.from({ length: 45 }, (_, index) => ({
    id: `55555555-5555-4555-8555-${String(index).padStart(12, '0')}`,
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    documentId: '33333333-3333-4333-8333-333333333333',
    content: `Evidence row ${index}.`, contentHash: `hash-${index}`,
    segmentType: 'paragraph', segmentIndex: index,
    metadata: { scope: 'organization', document_title: 'Batch evidence' },
  }));

  const coverage = await service._embedSegments(segments, '22222222-2222-4222-8222-222222222222');
  assert.deepEqual(embedBatchSizes.sort((a, b) => b - a), [20, 20, 5]);
  assert.equal(stored.length, 45);
  assert.deepEqual(coverage, { total: 45, embedded: 45, failed: 0, healed: 0 });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].where.id.in.length, 45);
});

test('invalid evidence vectors never reach Qdrant and remain recoverable', async () => {
  let storeCalls = 0;
  const updated = [];
  const service = new DocumentFirstIngestionService({
    db: { knowledgeSegment: { updateMany: async (query) => updated.push(query) } },
    memoryGraphEngine: {}, smartIngestRouter: null,
    embeddingService: {
      embed: async () => [],
      storeVectors: async () => { storeCalls += 1; },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  const coverage = await service._embedSegments([{
    id: '55555555-5555-4555-8555-555555555556',
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    documentId: '33333333-3333-4333-8333-333333333333',
    content: 'Evidence without a valid vector.', contentHash: 'invalid-vector',
    segmentType: 'paragraph', segmentIndex: 0,
  }], '22222222-2222-4222-8222-222222222222');
  assert.equal(storeCalls, 0);
  assert.deepEqual(updated, []);
  assert.deepEqual(coverage, { total: 1, embedded: 0, failed: 1, healed: 0 });
});

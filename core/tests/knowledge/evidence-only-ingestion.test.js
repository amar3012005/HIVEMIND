import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentFirstIngestionService,
  canonicalGenerationPolicy,
  buildPromotionSourceMap,
  locatePromotionWindow,
  resolveDocumentClassification,
  canReuseUnchangedDocument,
  ensureSourceAnchorCoverage,
  materializeClaimEntities,
  normalizeCuratedClaims,
  normalizeUnifiedEntityCatalog,
  promotionProvenance,
  repairSourceLanguageClaims,
} from '../../src/knowledge/document-first-ingestion.js';
import { EntityExtractor, isValidEntityCandidate } from '../../src/knowledge/entity-extractor.js';

test('both-mode entity catalog keeps grounded named entities outside promoted facts', () => {
  const source = 'Uwe Berger introduced SINGULANCE to Amar Sai. Should Singulance expand?';
  const entities = normalizeUnifiedEntityCatalog([
    { n: 'Uwe Berger', k: 'person', aliases: ['Uwe'] },
    { n: 'SINGULANCE', k: 'organization' },
    { n: 'Amar Sai', k: 'person' },
    { n: 'Should Singulance', k: 'person' },
    { n: 'Invented GmbH', k: 'organization' },
  ], source);

  assert.deepEqual(entities.map(({ name, kind }) => ({ name, kind })), [
    { name: 'Uwe Berger', kind: 'person' },
    { name: 'SINGULANCE', kind: 'organization' },
    { name: 'Amar Sai', kind: 'person' },
  ]);
  assert.deepEqual(entities[0].aliases, ['Uwe']);
  assert.equal(entities[0].mentionText, 'Uwe Berger');
  assert.equal(entities[0].startOffset, 0);
});

test('model-free entity extraction recognizes unambiguous enterprise names', () => {
  const extractor = new EntityExtractor({ prisma: null, logger: { warn() {} } });
  const entities = extractor.extractDeterministic(
    'Orion Harbor AG approved Project Lantern. Priya Nair and Uwe Berger selected SolvisControl-3.',
  );
  const keys = new Set(entities.map((entity) => `${entity.type}:${entity.name}`));
  assert.ok(keys.has('organization:Orion Harbor AG'));
  assert.ok(keys.has('project:Project Lantern'));
  assert.ok(keys.has('person:Priya Nair'));
  assert.ok(keys.has('person:Uwe Berger'));
  assert.ok(keys.has('product:SolvisControl-3'));
});

test('entity admission rejects question fragments and source artifacts', () => {
  assert.equal(isValidEntityCandidate({ name: 'Should Singulance', type: 'person' }), false);
  assert.equal(isValidEntityCandidate({ name: 'singulance-german-banks-first-DECISION-2026-09-11', type: 'organization' }), false);
  assert.equal(isValidEntityCandidate({ name: 'DaVinci_AI_Gruendungsstipendium_Final.docx', type: 'organization' }), false);
  assert.equal(isValidEntityCandidate({ name: 'Singulance', type: 'organization' }), true);
  assert.equal(isValidEntityCandidate({ name: 'Uwe Berger', type: 'person' }), true);
});

test('model candidates pass through the same deterministic entity admission gate', () => {
  const extractor = new EntityExtractor({ prisma: null, logger: { warn() {} } });
  const entities = extractor._mergeCandidates([], [
    { name: 'Should Singulance', type: 'person', source: 'llm', confidence: 0.9 },
    { name: 'pricing-plan-final.pdf', type: 'product', source: 'llm', confidence: 0.9 },
    { name: 'Singulance', type: 'organization', source: 'llm', confidence: 0.9 },
  ]);
  assert.deepEqual(entities.map((entity) => entity.name), ['Singulance']);
});

test('LLM entity extraction preserves precise technical entity types for the canonical registry', () => {
  const extractor = new EntityExtractor({ prisma: null, logger: { warn() {} } });
  const entities = extractor._mergeCandidates([], [
    { name: 'Model Context Protocol', type: 'standard', source: 'llm', confidence: 0.95 },
    { name: 'Apache AGE', type: 'technology', source: 'llm', confidence: 0.94 },
    { name: 'HIVEMIND Control Plane', type: 'system', source: 'llm', confidence: 0.93 },
  ]);
  assert.deepEqual(entities.map((entity) => ({ name: entity.name, type: entity.type })), [
    { name: 'Model Context Protocol', type: 'standard' },
    { name: 'Apache AGE', type: 'technology' },
    { name: 'HIVEMIND Control Plane', type: 'system' },
  ]);
});

test('structured claim subjects cannot bypass entity artifact admission', () => {
  const filename = materializeClaimEntities({
    f: 'The source singulance-german-banks-first-decision.md was superseded.',
    source_quote: 'singulance-german-banks-first-decision.md',
    entities: [],
    subject: { name: 'singulance-german-banks-first-decision.md', kind: 'document' },
  });
  const question = materializeClaimEntities({
    f: 'Should Singulance target German banks first?',
    source_quote: 'Should Singulance target German banks first?',
    entities: [],
    subject: { name: 'Should Singulance', kind: 'person' },
  });
  assert.deepEqual(filename, []);
  assert.deepEqual(question, []);
});

test('translated extraction is repaired to exact source-language text', () => {
  const quote = 'Atlas Meridian GmbH approved Project Lantern with a budget of EUR 42000 and a deadline of 30 November 2026.';
  const result = repairSourceLanguageClaims([{
    t: 'Genehmigung von Projekt Lantern',
    f: 'Atlas Meridian GmbH genehmigte Projekt Lantern mit einem Budget von 42.000 EUR.',
    source_quote: quote,
  }], 0.55);
  assert.equal(result[0].f, quote);
  assert.equal(result[0]._language_repaired, true);
  assert.equal(result._languageRepairCount, 1);
});

test('German pricing rows cannot survive as English claims despite shared brands and amounts', () => {
  const quote = 'Kore.ai liegt preislich zwischen €25k und €100k jährlich.';
  const result = repairSourceLanguageClaims([{
    t: 'Kore.ai pricing',
    f: 'Kore.ai pricing ranges from €25k to €100k annually.',
    source_quote: quote,
  }], 0.55);
  assert.equal(result[0].f, quote);
  assert.equal(result[0]._language_repaired, true);
});

test('German source context repairs an English expansion of a language-neutral table row', () => {
  const quote = 'Kore.ai\n€25k+\n€300k+\n€50k–100k\n€350k–400k';
  const context = 'Der Markt teilt sich in zwei Segmente. Anbieter Monatlich Jährlich Setup Gesamt Jahr 1.';
  const result = repairSourceLanguageClaims([{
    t: 'Kore.ai Pricing',
    f: 'Kore.ai pricing ranges from €25k+ monthly and €300k+ annually, with setup costs of €50k–100k.',
    source_quote: quote,
    source_context: context,
  }], 0.55);
  assert.equal(result[0].f, quote);
  assert.equal(result[0]._language_repaired, true);
});

test('curation repairs both content and title for German pricing table claims', () => {
  const quote = 'Kore.ai\n€25k+\n€300k+\n€50k–100k\n€350k–400k';
  const candidates = [{
    t: 'Kore.ai Preisangaben', f: quote, memory_type: 'fact', claim_kind: 'fact',
    importance: 0.96, source_quote: quote, segmentId: 'segment-1', entities: [],
    heading: '6.3 Wettbewerbsanalyse',
    source_window_content: 'Der Markt teilt sich in zwei Segmente. Anbieter Monatlich Jährlich Setup Gesamt Jahr 1.',
  }];
  const result = normalizeCuratedClaims([{
    title: 'Kore.ai Pricing', memory_type: 'fact', claim_kind: 'fact',
    content: 'Kore.ai pricing ranges from €25k+ monthly and €300k+ annually, with setup costs of €50k–100k.',
    support_indices: [0],
  }], candidates, 8);
  assert.equal(result[0].f, quote);
  assert.equal(result[0].t, '6.3 Wettbewerbsanalyse');
});

test('source-anchor coverage restores omitted entity, amount and deadline without invention', () => {
  const source = 'Atlas Meridian GmbH approved Project Lantern with a budget of EUR 42000 and a deadline of 30 November 2026. Priya Nair and Uwe Berger selected SolvisControl-3 and rejected Project Eclipse.';
  const result = ensureSourceAnchorCoverage([{
    t: 'Product choice',
    f: 'Priya Nair and Uwe Berger selected SolvisControl-3 and rejected Project Eclipse.',
    source_quote: 'Priya Nair and Uwe Berger selected SolvisControl-3 and rejected Project Eclipse.',
    importance: 0.9,
  }], source, 8);
  assert.equal(result.length, 2);
  const repaired = result.find((claim) => claim._coverage_fallback);
  assert.equal(repaired.f, 'Atlas Meridian GmbH approved Project Lantern with a budget of EUR 42000 and a deadline of 30 November 2026.');
  assert.equal(repaired.source_quote, repaired.f);
  assert.equal(repaired.claim_kind, 'decision');
  assert.ok(repaired.entities.some((entity) => entity.n === 'Atlas Meridian GmbH' && entity.k === 'organization'));
});

test('document curation cannot translate a grounded candidate', () => {
  const quote = 'Atlas Meridian GmbH approved Project Lantern with a budget of EUR 42000 and a deadline of 30 November 2026.';
  const candidates = [{
    t: 'Project Lantern approval', f: quote, memory_type: 'fact', claim_kind: 'decision',
    importance: 0.96, source_quote: quote, segmentId: 'segment-1', entities: [],
  }];
  const result = normalizeCuratedClaims([{
    title: 'Genehmigung von Projekt Lantern', memory_type: 'fact', claim_kind: 'decision',
    content: 'Atlas Meridian GmbH genehmigte Projekt Lantern mit einem Budget von 42.000 EUR.',
    support_indices: [0],
  }], candidates, 8);
  assert.equal(result[0].f, quote);
});

test('unchanged evidence documents are reusable without a memory projection', () => {
  assert.equal(canReuseUnchangedDocument({ ingestMode: 'evidence', segmentCount: 3, memoryLinkCount: 0 }), true);
  assert.equal(canReuseUnchangedDocument({ ingestMode: 'both', segmentCount: 3, memoryLinkCount: 0 }), false);
  assert.equal(canReuseUnchangedDocument({ ingestMode: 'both', segmentCount: 3, memoryLinkCount: 2 }), true);
  assert.equal(canReuseUnchangedDocument({ ingestMode: 'evidence', segmentCount: 0, memoryLinkCount: 0 }), false);
});

test('unchanged evidence exits before parser, classifier, or model work', async () => {
  let parserCalls = 0;
  const service = new DocumentFirstIngestionService({
    db: {
      knowledgeDocument: {
        findFirst: async () => ({ id: '33333333-3333-4333-8333-333333333333', ingestMode: 'evidence' }),
      },
      knowledgeSegment: { count: async () => 2 },
      memoryEvidenceLink: { count: async () => 0 },
    },
    memoryGraphEngine: {},
    smartIngestRouter: null,
    doclingAdapter: {
      parseBuffer: async () => {
        parserCalls += 1;
        throw new Error('parser must not run for unchanged evidence');
      },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await service._ingestKnowledgeDocumentOnce({
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    filename: 'unchanged.txt',
    fileBuffer: Buffer.from('Already indexed evidence.'),
    contentType: 'text/plain',
    metadata: { ingest_mode: 'evidence', scope: 'personal' },
  });

  assert.equal(parserCalls, 0);
  assert.equal(result.skippedUnchanged, true);
  assert.equal(result.promotedCount, 0);
  assert.equal(result.segmentCount, 2);
});

test('promotion windows retain exact source segment ownership after re-chunking', () => {
  const segments = [
    { id: 'segment-a', content: 'Alpha introduction and context.', startPage: 1, metadata: { heading: 'Alpha' } },
    { id: 'segment-b', content: 'Beta owns the decisive pricing statement.', startPage: 7, metadata: { heading: 'Pricing' } },
    { id: 'segment-c', content: 'Gamma contains the final implementation date.', startPage: 9, metadata: { heading: 'Timeline' } },
  ];
  const source = buildPromotionSourceMap(segments);

  assert.equal(source.text, segments.map((segment) => segment.content).join('\n\n'));
  assert.deepEqual(locatePromotionWindow('Beta owns the decisive pricing statement.', source, 0), {
    segmentId: 'segment-b',
    heading: 'Pricing',
    page: 7,
    startOffset: 33,
    endOffset: 74,
  });
  assert.equal(
    locatePromotionWindow('pricing statement.\n\nGamma contains', source, 0).segmentId,
    'segment-b',
    'a cross-segment window belongs to the segment with the largest byte overlap',
  );
});

test('evidence mode classifies deterministically without invoking an LLM', async () => {
  let classifierCalls = 0;
  const result = await resolveDocumentClassification({
    ingestMode: 'evidence',
    metadata: {},
    text: 'A plain evidence passage.',
    filename: 'notes.txt',
    classify: async () => {
      classifierCalls += 1;
      return { type: 'llm-result', confidence: 1 };
    },
  });

  assert.equal(classifierCalls, 0);
  assert.deepEqual(result, { type: 'general', confidence: 1, method: 'deterministic_evidence' });
});

test('evidence entity indexing uses deterministic extraction and settles segment plus document receipts', async () => {
  let llmCalls = 0;
  let written = null;
  const service = new DocumentFirstIngestionService({
    db: {}, memoryGraphEngine: {}, smartIngestRouter: null,
    entityExtractor: {
      extractDeterministic: (text) => [{ name: 'Amar Sai Gadde', type: 'person', surfaceForm: 'Amar Sai Gadde', startOffset: text.indexOf('Amar') }],
      _llmExtract: async () => { llmCalls += 1; return []; },
    },
  });
  service._persistCanonicalEntityResources = async (input) => { written = input; return { linked: 2 }; };
  const coverage = await service._persistDeterministicEvidenceEntities({
    segments: [{ id: '55555555-5555-4555-8555-555555555555', content: 'Amar Sai Gadde approved the plan.' }],
    documentId: '33333333-3333-4333-8333-333333333333',
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    metadata: { scope: 'organization', filename: 'decision.md' },
  });
  assert.equal(llmCalls, 0);
  assert.equal(written.extractorRoute, 'deterministic_regex');
  assert.equal(written.modelRoute, null);
  assert.deepEqual(written.resources.map((resource) => resource.resourceType), ['segment', 'document']);
  assert.equal(written.resources[0].entities[0].kind, 'person');
  assert.equal(written.resources[1].entities.some((entity) =>
    entity.kind === 'document' && entity.name === 'decision.md'), false);
  assert.equal(coverage.linked, 2);
});

test('entity coverage reconciliation treats completed_zero as durable and detects missing receipts', async () => {
  const segmentId = '55555555-5555-4555-8555-555555555555';
  const documentId = '33333333-3333-4333-8333-333333333333';
  const orgId = '22222222-2222-4222-8222-222222222222';
  const receipts = [
    { resourceType: 'document', resourceId: documentId, status: 'completed_zero', processingVersion: 1 },
    { resourceType: 'segment', resourceId: segmentId, status: 'completed', processingVersion: 1 },
  ];
  const service = new DocumentFirstIngestionService({
    db: {
      knowledgeSegment: { findMany: async () => [{ id: segmentId }] },
      entityExtractionReceipt: { findMany: async () => receipts },
      resourceEntityLink: { count: async () => 1 },
    },
    memoryGraphEngine: {}, smartIngestRouter: null,
  });
  const complete = await service.reconcileEntityCoverage({ documentId, orgId });
  assert.equal(complete.complete, true);
  assert.equal(complete.zeroEntityResources, 1);
  assert.equal(complete.links, 1);

  receipts.pop();
  const incomplete = await service.reconcileEntityCoverage({ documentId, orgId });
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.pending, 1);
});

test('document parent summaries inherit canonical entities and receive a zero-extra-model receipt', async () => {
  let persisted = null;
  const service = new DocumentFirstIngestionService({
    db: {},
    memoryGraphEngine: {
      ingestMemory: async ({ id }) => ({ memoryId: id }),
      vectorStore: { storeMemory: async () => true },
      applyValidatedRelationship: async () => ({}),
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  service._persistCanonicalEntityResources = async (input) => {
    persisted = input;
    return { linked: input.resources[0].entities.length };
  };

  const memories = [{
    id: '66666666-6666-4666-8666-666666666666',
    content: 'short',
    extracted_entities: [
      { name: 'Solvis GmbH', kind: 'organization' },
      { name: 'Project Aurora', kind: 'project' },
    ],
  }];
  const parentId = await service._attachDocumentParent({
    memories,
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    documentId: '33333333-3333-4333-8333-333333333333',
    metadata: { filename: 'pilot.txt', scope: 'personal' },
    totalFacts: 1,
    canonicalEntities: [{ name: 'Uwe Berger', kind: 'person' }],
  });

  assert.ok(parentId);
  assert.equal(persisted.extractorRoute, 'document_parent_inherit');
  assert.equal(persisted.modelRoute, null);
  assert.equal(persisted.resources[0].resourceType, 'memory');
  assert.equal(persisted.resources[0].resourceId, parentId);
  assert.deepEqual(persisted.resources[0].entities, [
    { name: 'Uwe Berger', kind: 'person' },
    ...memories[0].extracted_entities,
  ]);
  assert.equal(memories.at(-1).memory_type, 'summary');
});

test('legacy generation env flags cannot fork the canonical memory and entity pipeline', () => {
  const previous = {
    extract: process.env.KB_UNIFIED_EXTRACT,
    relations: process.env.KB_DOC_RELATIONS,
    consolidate: process.env.KB_CONSOLIDATE,
    linkMode: process.env.KB_ENTITY_LINK_MODE,
    context: process.env.KB_MEMORY_CONTEXT_PREFIX,
    claimStructuring: process.env.V5_CLAIM_STRUCTURING,
    atomicFacts: process.env.KB_ATOMIC_FACTS,
    semanticSegments: process.env.KB_SEMANTIC_SEGMENTS,
    skipUnchanged: process.env.KB_SKIP_UNCHANGED,
    enrichment: process.env.KB_ENRICH_ENABLED,
    versionEdges: process.env.KB_ENABLE_ALGO_VERSION_EDGES,
  };
  Object.assign(process.env, {
    KB_UNIFIED_EXTRACT: 'false',
    KB_DOC_RELATIONS: 'false',
    KB_CONSOLIDATE: '0',
    KB_ENTITY_LINK_MODE: 'llm',
    KB_MEMORY_CONTEXT_PREFIX: 'false',
    V5_CLAIM_STRUCTURING: 'false',
    KB_ATOMIC_FACTS: 'false',
    KB_SEMANTIC_SEGMENTS: 'false',
    KB_SKIP_UNCHANGED: '0',
    KB_ENRICH_ENABLED: '1',
    KB_ENABLE_ALGO_VERSION_EDGES: 'true',
  });
  try {
    assert.deepEqual(canonicalGenerationPolicy(), {
      extractor: 'unified',
      entityLinkMode: 'hybrid',
      documentRelations: true,
      consolidate: true,
      sourceContextPrefix: true,
      claimStructuring: true,
      atomicFacts: true,
      semanticSegments: true,
      skipUnchanged: true,
      phaseTwoEnrichment: false,
      algorithmicVersionEdges: false,
    });
  } finally {
    for (const [key, value] of Object.entries({
      KB_UNIFIED_EXTRACT: previous.extract,
      KB_DOC_RELATIONS: previous.relations,
      KB_CONSOLIDATE: previous.consolidate,
      KB_ENTITY_LINK_MODE: previous.linkMode,
      KB_MEMORY_CONTEXT_PREFIX: previous.context,
      V5_CLAIM_STRUCTURING: previous.claimStructuring,
      KB_ATOMIC_FACTS: previous.atomicFacts,
      KB_SEMANTIC_SEGMENTS: previous.semanticSegments,
      KB_SKIP_UNCHANGED: previous.skipUnchanged,
      KB_ENRICH_ENABLED: previous.enrichment,
      KB_ENABLE_ALGO_VERSION_EDGES: previous.versionEdges,
    })) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('canonical evidence envelopes persist as documents and segments, never hidden memory rows', async () => {
  const service = new DocumentFirstIngestionService({
    db: {},
    memoryGraphEngine: {
      ingestMemory: async () => { throw new Error('evidence must not create a memory row'); },
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  let connectorInput = null;
  service.ingestConnectorRecord = async (input) => {
    connectorInput = input;
    return {
      documentId: 'doc-evidence', segmentCount: 1, candidateCount: 0,
      promotedCount: 0, promotedMemoryIds: [], evidenceOnlyReason: 'user_selected',
    };
  };

  const result = await service.ingestSource({
    userId: 'user-1', orgId: 'org-1', content: 'A source-grounded transcript.',
    mode: 'evidence', ingestMode: 'evidence',
    source: { type: 'meeting', sourceId: 'meeting-1', title: 'Weekly meeting' },
  });

  assert.equal(connectorInput.metadata.ingest_mode, 'evidence');
  assert.equal(result.documentId, 'doc-evidence');
  assert.deepEqual(result.memoryIds, []);
  assert.equal(result.promotedCount, 0);
});

test('canonical atomic ingestion delegates entity projection exactly once', async () => {
  let graphInput = null;
  const service = new DocumentFirstIngestionService({
    db: {},
    memoryGraphEngine: {
      ingestMemory: async (input) => {
        graphInput = input;
        return { memoryId: '66666666-6666-4666-8666-666666666666' };
      },
      store: { getMemories: async () => new Map() },
    },
    logger: { info() {}, warn() {}, error() {} },
  });

  const result = await service.ingestSource({
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    content: 'Sahana Iyer leads the Nimbus Ridge launch.',
    mode: 'atomic',
    source: { type: 'mcp', sourceId: 'save-1', title: 'Launch fact' },
  });

  assert.equal(graphInput.defer_entity_linking, true,
    'GraphEngine must not enqueue a second canonical projection');
  assert.deepEqual(result.memoryIds, ['66666666-6666-4666-8666-666666666666']);
});

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
    return {
      candidates: [{ segmentId: input.segments[0].id }],
      memories: [{ id: '66666666-6666-4666-8666-666666666666' }],
      coverage: { memory_embed: { total: 1, embedded: 1, failed: 0, healed: 0 } },
    };
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
  assert.deepEqual(result.coverage.memory_embed, { total: 1, embedded: 1, failed: 0, healed: 0 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].data.ingestMode, 'both');
  assert.equal(updates[0].data.parseMetadata.original_ingest_mode, 'evidence');
});

test('forced stored-evidence promotion replaces the previous active memory projection', async () => {
  const documentId = '33333333-3333-4333-8333-333333333333';
  let reads = 0;
  const retired = [];
  const removedVectors = [];
  const service = new DocumentFirstIngestionService({
    db: {
      knowledgeDocument: {
        findFirst: async () => ({
          id: documentId, userId: '11111111-1111-4111-8111-111111111111', ingestMode: 'evidence',
          title: 'Evidence report', documentType: 'file', sourcePlatform: 'knowledge_upload',
          sourceId: 'report-source', tags: [], parseMetadata: {},
          segments: [{
            id: '55555555-5555-4555-8555-555555555555', content: 'Der bestätigte Starttermin ist der 14. September 2028.',
            segmentIndex: 0, segmentType: 'chunk', metadata: {},
          }],
        }),
        update: async () => ({}),
      },
      memoryEvidenceLink: {
        findMany: async () => {
          reads += 1;
          if (reads === 1) return [{ memoryId: 'old-memory' }];
          return [{ memoryId: 'old-memory', documentId }];
        },
      },
      $transaction: async (fn) => fn({
        memoryEvidenceLink: { deleteMany: async () => ({ count: 1 }) },
        relationship: { deleteMany: async () => ({ count: 0 }) },
        vectorEmbedding: { deleteMany: async () => ({ count: 0 }) },
        memory: { updateMany: async ({ where }) => { retired.push(...where.id.in); return { count: 1 }; } },
      }),
    },
    memoryGraphEngine: {
      vectorStore: {
        deleteMemory: async (id) => { removedVectors.push(id); return true; },
      },
    },
    smartIngestRouter: null, embeddingService: null,
    logger: { info() {}, warn() {}, error() {} },
  });
  service._promoteMemories = async () => ({
    candidates: [{}], memories: [{ id: 'new-memory' }],
    coverage: { memory_embed: { total: 1, embedded: 1, failed: 0, healed: 0 } },
  });
  service._structureClaimsAsync = async () => {};
  service._projectPromotedCanonicalKnowledge = async () => {};

  const result = await service.promoteStoredEvidence({
    documentId,
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    metadata: { force_reprocess: true },
  });

  assert.deepEqual(removedVectors, ['old-memory']);
  assert.deepEqual(retired, ['old-memory']);
  assert.deepEqual(result.coverage.projection_replacement, { stale: 1, retired: 1, detached: 0 });
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
  const parentVectors = [];
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
      applyValidatedRelationship: async (edge) => {
        relationships.push(edge);
        return { operation: 'attached', edgesCreated: [edge] };
      },
      store: {},
      vectorStore: {
        storeMemory: async (memory, options) => {
          parentVectors.push({ memory, options });
          return memory.id;
        },
      },
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
  assert.equal(parentVectors.length, 1);
  assert.equal(parentVectors[0].memory.id, 'parent-1');
  assert.equal(parentVectors[0].memory.memory_type, 'summary');
  assert.equal(memories[14]._vectorEmbedded, true);
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
  service._parseDocument = async (_buffer, _contentType, _filename, options) => {
    calls.push(['parser-picture-descriptions', options.picture_descriptions]);
    return {
      success: true,
      text: 'The Atlas launch date is 14 September 2028.',
      markdown: '# Atlas\nThe Atlas launch date is 14 September 2028.',
      wordCount: 9,
      pages: 1,
      engine: 'test-parser',
      metadata: { pages: 1 },
      tables: [],
    };
  };
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
    assert.deepEqual(calls, [
      ['parser-picture-descriptions', false],
      ['document', 'evidence'],
      ['hybrid-index'],
    ]);
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

test('memories plus evidence also stops before promotion when evidence indexing is incomplete', async () => {
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
  service._promoteMemoriesGuarded = async () => assert.fail('promotion must wait for evidence reconciliation');

  const oldSkip = process.env.KB_SKIP_UNCHANGED;
  process.env.KB_SKIP_UNCHANGED = '0';
  try {
    await assert.rejects(service.ingestKnowledgeDocument({
      userId: '11111111-1111-4111-8111-111111111111',
      orgId: '22222222-2222-4222-8222-222222222222',
      filename: 'incomplete-both.txt', fileBuffer: Buffer.from('Evidence text.'), contentType: 'text/plain',
      metadata: { scope: 'organization', document_type: 'general', ingest_mode: 'both' },
    }), (error) => error?.code === 'EVIDENCE_INDEX_INCOMPLETE');
  } finally {
    if (oldSkip === undefined) delete process.env.KB_SKIP_UNCHANGED;
    else process.env.KB_SKIP_UNCHANGED = oldSkip;
  }
});

test('durable retry embeds only persisted segments still missing vectors', async () => {
  const documentId = '33333333-3333-4333-8333-333333333333';
  const pending = {
    id: '55555555-5555-4555-8555-555555555555', documentId,
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    content: 'Persisted evidence awaiting a vector.', contentHash: 'pending-vector',
    segmentType: 'paragraph', segmentIndex: 0, vectorStored: false, metadata: {},
  };
  const db = {
    sourceArtifact: {
      upsert: async () => ({ id: '44444444-4444-4444-8444-444444444444', payload: {} }),
      update: async () => ({}),
    },
    knowledgeDocument: { findFirst: async () => null, upsert: async () => ({ id: documentId }) },
    knowledgeSegment: { findMany: async () => [pending], count: async () => 1 },
    memoryEvidenceLink: { count: async () => 0 },
  };
  const service = new DocumentFirstIngestionService({
    db, memoryGraphEngine: {}, smartIngestRouter: null, embeddingService: {},
    logger: { info() {}, warn() {}, error() {} },
  });
  service._parseDocument = async () => ({
    success: true, text: pending.content, markdown: pending.content, wordCount: 6,
    pages: 1, engine: 'test-parser', metadata: { pages: 1 }, tables: [],
  });
  service._createSegments = async () => assert.fail('retry must reuse persisted segments');
  let embeddedSegments = [];
  service._embedSegments = async (segments) => {
    embeddedSegments = segments;
    return { total: segments.length, embedded: segments.length, failed: 0, healed: 0 };
  };
  service._promoteMemoriesGuarded = async () => assert.fail('evidence-only must not promote');

  const oldSkip = process.env.KB_SKIP_UNCHANGED;
  process.env.KB_SKIP_UNCHANGED = '0';
  try {
    const result = await service.ingestKnowledgeDocument({
      userId: pending.userId, orgId: pending.orgId,
      filename: 'retry.txt', fileBuffer: Buffer.from(pending.content), contentType: 'text/plain',
      metadata: { scope: 'organization', document_type: 'general', ingest_mode: 'evidence' },
    });
    assert.deepEqual(embeddedSegments.map((segment) => segment.id), [pending.id]);
    assert.deepEqual(result.coverage.evidence_embed, { total: 1, embedded: 1, failed: 0, healed: 1 });
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
  const calls = [];
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
      ensureCollection: async (collectionName) => { calls.push(`ensure:${collectionName}`); return true; },
      storeVectors: async ({ collectionName, points }) => { calls.push(`store:${collectionName}`); stored.push(...points); },
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
  assert.equal(calls.length, 2);
  assert.match(calls[0], /^ensure:/);
  assert.equal(calls[1], calls[0].replace('ensure:', 'store:'));
  assert.deepEqual(coverage, { total: 45, embedded: 45, failed: 0, healed: 0 });
  assert.equal(updated.length, 1);
  assert.equal(updated[0].where.id.in.length, 45);
});

test('a vector marker write failure remains incomplete even when Qdrant accepted the batch', async () => {
  const service = new DocumentFirstIngestionService({
    db: { knowledgeSegment: { updateMany: async () => { throw new Error('postgres unavailable'); } } },
    memoryGraphEngine: {}, smartIngestRouter: null,
    embeddingService: {
      embed: async () => Array(1024).fill(0.1),
      ensureCollection: async () => true,
      storeVectors: async () => {},
    },
    logger: { info() {}, warn() {}, error() {} },
  });
  const coverage = await service._embedSegments([{
    id: '55555555-5555-4555-8555-555555555557',
    userId: '11111111-1111-4111-8111-111111111111',
    orgId: '22222222-2222-4222-8222-222222222222',
    documentId: '33333333-3333-4333-8333-333333333333',
    content: 'Evidence with an uncommitted vector marker.', contentHash: 'marker-failure',
    segmentType: 'paragraph', segmentIndex: 0,
  }], '22222222-2222-4222-8222-222222222222');

  assert.deepEqual(coverage, { total: 1, embedded: 0, failed: 1, healed: 0 });
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

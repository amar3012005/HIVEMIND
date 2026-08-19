import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DocumentFirstIngestionService,
  adaptiveAtomicMemoryBudget,
  normalizeCuratedClaims,
  normalizeUnifiedClaims,
  resolveEvidenceSegment,
  splitDenseExtractionContent,
} from '../../src/knowledge/document-first-ingestion.js';

test('atomic memory budget scales by information-bearing source size without page-count explosion', () => {
  assert.equal(adaptiveAtomicMemoryBudget(2_000, 50), 12);
  assert.equal(adaptiveAtomicMemoryBudget(20_000, 50), 30);
  assert.equal(adaptiveAtomicMemoryBudget(100_000, 200), 60);
  assert.equal(adaptiveAtomicMemoryBudget(100_000, 9), 9);
});

test('unified promotion validates multilingual exact source spans and durable types', () => {
  const source = 'Der Vorstand beschloss, das Projekt am 15. Juli zu starten. 次の会議は8月3日に東京で開催されます。';
  const claims = normalizeUnifiedClaims([
    {
      t: 'Projektstart',
      f: 'Der Vorstand beschloss einen Projektstart am 15. Juli.',
      memory_type: 'decision',
      source_quote: 'Der Vorstand beschloss, das Projekt am 15. Juli zu starten.',
      importance: 0.9,
      entities: ['Vorstand'],
      rels: [{ to: 1, type: 'Extends' }],
    },
    {
      t: '次の会議',
      f: '次の会議は8月3日に東京で開催される。',
      memory_type: 'event',
      source_quote: '次の会議は8月3日に東京で開催されます。',
      importance: 0.8,
      entities: ['東京'],
      rels: [],
    },
  ], source, 8);

  assert.deepEqual(claims.map((claim) => claim.memory_type), ['decision', 'event']);
  for (const claim of claims) {
    assert.equal(source.slice(claim.source_start, claim.source_end), claim.source_quote);
  }
});

test('unified promotion preserves language-neutral atomic claim structure', () => {
  const source = 'SolvisPia 13/17 ist eine Luft/Wasser-Wärmepumpe.';
  const [claim] = normalizeUnifiedClaims([{
    t: 'SolvisPia 13/17', f: source, memory_type: 'fact', source_quote: source,
    importance: 0.96, extraction_confidence: 0.98,
    subject: { n: 'SolvisPia 13/17', k: 'product' },
    predicate: 'product_category',
    object: { value: 'Luft/Wasser-Wärmepumpe', type: 'product_category' },
    qualifiers: { negated: false },
    entities: [{ n: 'SolvisPia 13/17', k: 'product' }],
    relationships: [{
      from: { n: 'SolvisPia 13/17', k: 'product' }, type: 'variant_of',
      to: { n: 'SolvisPia', k: 'product' },
    }],
  }], source, 5, 0.65);

  assert.equal(claim.subject.name, 'SolvisPia 13/17');
  assert.equal(claim.subject.kind, 'product');
  assert.equal(claim.predicate, 'product_category');
  assert.equal(claim.qualifiers.object, 'Luft/Wasser-Wärmepumpe');
  assert.equal(claim.qualifiers.object_type, 'product_category');
  assert.equal(claim.qualifiers.relationships[0].type, 'variant_of');
  assert.equal(claim.extractionConfidence, 0.98);
});

test('unified promotion keeps ambiguity as evidence and rejects raw update edges', () => {
  const source = 'The approved retention period is seven years.';
  const claims = normalizeUnifiedClaims([
    {
      t: 'Unsupported summary', f: 'The source provides a summary.', memory_type: 'summary',
      source_quote: source, importance: 0.7, entities: [], rels: [],
    },
    {
      t: 'Invented claim', f: 'The retention period is ten years.', memory_type: 'fact',
      source_quote: 'The retention period is ten years.', importance: 0.7, entities: [], rels: [],
    },
    {
      t: 'Retention period', f: 'The approved retention period is seven years.', memory_type: 'fact',
      source_quote: source, importance: 0.9, entities: [],
      rels: [{ to: 0, type: 'Updates' }, { to: 0, type: 'Contradicts' }],
    },
  ], source, 8);

  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].rels, [{ to: 0, type: 'Contradicts' }]);
});

test('unified promotion retains low-salience content as evidence instead of memory', () => {
  const source = 'The approved retention period is seven years. The office lobby is painted blue.';
  const claims = normalizeUnifiedClaims([
    {
      t: 'Retention period', f: 'The approved retention period is seven years.', memory_type: 'fact',
      source_quote: 'The approved retention period is seven years.', importance: 0.91, entities: [], rels: [],
    },
    {
      t: 'Lobby color', f: 'The office lobby is painted blue.', memory_type: 'fact',
      source_quote: 'The office lobby is painted blue.', importance: 0.35, entities: [], rels: [],
    },
  ], source, 8, 0.65);

  assert.deepEqual(claims.map((claim) => claim.t), ['Retention period']);
});

test('unified promotion keeps markup and style code as evidence only', () => {
  const source = '.blue{color:var(--blue-deep);} The approved retention period is seven years.';
  const claims = normalizeUnifiedClaims([
    {
      t: 'CSS', f: '.blue{color:var(--blue-deep);}', memory_type: 'fact',
      source_quote: '.blue{color:var(--blue-deep);}', importance: 1, entities: ['CSS'], rels: [],
    },
    {
      t: 'Retention', f: 'The approved retention period is seven years.', memory_type: 'fact',
      source_quote: 'The approved retention period is seven years.', importance: 0.9, entities: [], rels: [],
    },
  ], source, 8, 0.65);
  assert.deepEqual(claims.map((claim) => claim.t), ['Retention']);
});

test('document curation merges support without losing source provenance', () => {
  const candidates = [
    { t: 'Retention', f: 'Retention is seven years.', memory_type: 'fact', importance: 0.9, entities: ['Policy'], segmentId: 's1', source_quote: 'Retention is seven years.' },
    { t: 'Owner', f: 'The compliance officer owns reviews.', memory_type: 'fact', importance: 0.82, entities: ['Compliance Officer'], segmentId: 's2', source_quote: 'The compliance officer owns reviews.' },
    { t: 'Scope', f: 'The policy applies to every managed customer workspace.', memory_type: 'fact', importance: 0.8, entities: ['Customer Workspace'], segmentId: 's3', source_quote: 'The policy applies to every managed customer workspace.' },
  ];
  const claims = normalizeCuratedClaims([{
    title: 'Retention review policy',
    content: 'Records are retained for seven years. The compliance officer owns the reviews. The policy applies to every managed customer workspace.',
    memory_type: 'fact', importance: 0.94, support_indices: [0, 1, 2], entities: ['Policy'],
  }], candidates, 8);

  assert.equal(claims.length, 1);
  assert.match(claims[0].f, /every managed customer workspace/);
  assert.deepEqual(claims[0].support_segment_ids, ['s1', 's2', 's3']);
  assert.deepEqual(claims[0].support_quotes, candidates.map((candidate) => candidate.source_quote));
  assert.deepEqual(claims[0].entities, ['Policy', 'Compliance Officer', 'Customer Workspace']);
});

test('re-windowed claims resolve to the exact persisted evidence segment', () => {
  const segments = [
    { id: 'segment-intro', content: 'General introduction and background.' },
    { id: 'segment-policy', content: 'The board approved a seven-year retention period.' },
    { id: 'segment-owner', content: 'Mira Chen owns the annual compliance review.' },
  ];
  assert.equal(
    resolveEvidenceSegment('Mira Chen owns the annual compliance review.', segments, 'segment-intro'),
    'segment-owner',
  );
  assert.equal(resolveEvidenceSegment('missing quote', segments, 'segment-intro'), 'segment-intro');
});

test('document curation preserves the primary extraction window for exact spans', () => {
  const candidates = [{
    t: 'Retention', f: 'Retention is seven years.', memory_type: 'fact', importance: 0.9,
    entities: ['Policy'], segmentId: 's1', source_quote: 'Retention is seven years.',
    source_window_content: 'Policy context. Retention is seven years. Review context.',
  }];
  const [claim] = normalizeCuratedClaims([{
    title: 'Retention policy', content: 'Retention is seven years.', memory_type: 'fact',
    importance: 0.9, support_indices: [0], entities: ['Policy'],
  }], candidates, 8);
  assert.equal(claim.source_window_content, candidates[0].source_window_content);
});

test('document curation rejects unsupported references and invalid memory types', () => {
  const candidates = [{ t: 'Launch', f: 'Launch is 15 July.', memory_type: 'event', importance: 0.9, entities: [], segmentId: 's1', source_quote: 'Launch is 15 July.' }];
  const claims = normalizeCuratedClaims([
    { title: 'Unsupported', content: 'Unsupported invented claim.', memory_type: 'fact', importance: 1, support_indices: [9], entities: [] },
    { title: 'Relationship', content: 'A relationship row.', memory_type: 'relationship', importance: 1, support_indices: [0], entities: [] },
  ], candidates, 8);
  assert.deepEqual(claims, []);
});

test('unified ingestion persists the classified type and exact evidence link', async () => {
  const ingested = [];
  const links = [];
  const derivations = [];
  const relationships = [];
  const service = new DocumentFirstIngestionService({
    db: {
      memoryEvidenceLink: { createMany: async ({ data }) => links.push(...data) },
      memoryDerivation: { createMany: async ({ data }) => derivations.push(...data) },
    },
    memoryGraphEngine: {
      vectorStore: null,
      ingestMemory: async (payload) => {
        ingested.push(payload);
        return { memoryId: `m${ingested.length}`, operation: 'created' };
      },
      store: { createRelationship: async (edge) => relationships.push(edge) },
    },
  });
  service._extractUnified = async () => [{
    t: 'Approved launch',
    f: 'The board approved the launch on 15 July.',
    memory_type: 'decision',
    source_quote: 'approved the launch on 15 July',
    source_start: 10,
    source_end: 40,
    importance: 0.93,
    extraction_confidence: 0.97,
    subject: { n: 'Launch', k: 'product' },
    predicate: 'approved_launch_date',
    object: { value: '15 July', type: 'date' },
    entities: ['Board'],
    rels: [],
  }];

  const result = await service._ingestUnifiedWindow(
    { segmentId: 'segment-1', content: 'The board approved the launch on 15 July.' },
    { userId: 'user-1', orgId: 'org-1', documentId: 'doc-1', metadata: { scope: 'organization' }, docTitle: 'Plan' },
  );

  assert.equal(result[0].memory_type, 'decision');
  assert.equal(ingested[0].memory_type, 'decision');
  assert.equal(ingested[0].claim_subject, 'Launch');
  assert.equal(ingested[0].claim_predicate, 'approved_launch_date');
  assert.equal(ingested[0].claim_qualifiers.object, '15 July');
  assert.equal(ingested[0].extraction_confidence, 0.97);
  assert.match(ingested[0].claim_key, /^[a-f0-9]{64}$/);
  assert.equal(ingested[0].metadata.claim.subject.name, 'Launch');
  assert.equal(ingested[0].metadata.claim.object.value, '15 July');
  assert.deepEqual(links[0], {
    memoryId: 'm1', documentId: 'doc-1', segmentId: 'segment-1',
    linkType: 'supports', confidence: 0.93, excerpt: 'approved the launch on 15 July',
  });
  assert.equal(derivations[0].metadata.source_start, 10);
  assert.equal(relationships.length, 0);
});

test('document parent is a bounded summary with structural PartOf edges', async () => {
  const ingested = [];
  const relationships = [];
  const service = new DocumentFirstIngestionService({
    db: {},
    memoryGraphEngine: {
      ingestMemory: async (payload) => { ingested.push(payload); return { memoryId: 'parent-1' }; },
      store: { createRelationship: async (edge) => relationships.push(edge) },
    },
  });
  const memories = [{ id: 'm1', title: 'Retention policy' }, { id: 'm2', title: 'Review owner' }];
  const parentId = await service._attachDocumentParent({
    memories, userId: 'u1', orgId: 'o1', documentId: 'd1',
    metadata: { filename: 'policy.pdf', scope: 'organization' }, totalFacts: 2,
    firstContent: '<html>raw source must not become the parent memory</html>',
  });

  assert.equal(parentId, 'parent-1');
  assert.equal(ingested[0].memory_type, 'summary');
  assert.match(ingested[0].content, /Key topics: Retention policy; Review owner/);
  assert.doesNotMatch(ingested[0].content, /raw source/);
  assert.deepEqual(relationships.map((edge) => edge.type), ['PartOf', 'PartOf']);
});

test('canonical entity extraction runs only over curated durable memories', async () => {
  const previous = process.env.ENABLE_ENTITY_EXTRACTION;
  process.env.ENABLE_ENTITY_EXTRACTION = 'true';
  const seen = [];
  const service = new DocumentFirstIngestionService({
    db: {},
    entityExtractor: { extractFromSegment: async (args) => seen.push(args.segment) },
    logger: { info() {}, warn() {} },
  });
  service._extractPromotedEntitiesAsync({
    memories: [
      { id: 'm1', content: 'A curated claim.', support_segment_ids: ['s1'] },
      { id: 'm2', content: 'Uncurated legacy row.' },
      { id: 'parent', content: 'Document summary.', isParent: true, support_segment_ids: ['s2'] },
    ],
    userId: 'u1', orgId: 'o1', documentId: 'd1',
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(seen, [{ id: 's1', content: 'A curated claim.' }]);
  if (previous === undefined) delete process.env.ENABLE_ENTITY_EXTRACTION;
  else process.env.ENABLE_ENTITY_EXTRACTION = previous;
});

test('document deletion cancels queued entity enrichment before source rows disappear', async () => {
  const previousEnabled = process.env.ENABLE_ENTITY_EXTRACTION;
  const previousConcurrency = process.env.ENTITY_EXTRACT_CONCURRENCY;
  process.env.ENABLE_ENTITY_EXTRACTION = 'true';
  process.env.ENTITY_EXTRACT_CONCURRENCY = '1';
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const seen = [];
  const service = new DocumentFirstIngestionService({
    db: {},
    entityExtractor: {
      extractFromSegment: async ({ segment, shouldContinue }) => {
        seen.push(segment.id);
        await gate;
        return shouldContinue() ? { skipped: false } : { skipped: true, reason: 'document_deleted' };
      },
    },
    logger: { info() {}, warn() {} },
  });
  const flight = service._extractEntitiesAsync({
    segments: [{ id: 's1', content: 'First durable entity-bearing claim.' }, { id: 's2', content: 'Second durable entity-bearing claim.' }],
    userId: 'u1', orgId: 'o1', documentId: 'd-delete', force: true,
  });
  await new Promise((resolve) => setImmediate(resolve));
  await service.cancelDocumentEnrichment('d-delete', { waitMs: 0 });
  release();
  await flight;
  assert.deepEqual(seen, ['s1']);
  assert.equal(service.entityExtractionFlights.has('d-delete'), false);
  if (previousEnabled === undefined) delete process.env.ENABLE_ENTITY_EXTRACTION;
  else process.env.ENABLE_ENTITY_EXTRACTION = previousEnabled;
  if (previousConcurrency === undefined) delete process.env.ENTITY_EXTRACT_CONCURRENCY;
  else process.env.ENTITY_EXTRACT_CONCURRENCY = previousConcurrency;
});

test('curated Updates use the atomic version operator', async () => {
  const calls = [];
  const service = new DocumentFirstIngestionService({
    db: {},
    memoryGraphEngine: {
      applyUpdate: async (...args) => calls.push(args),
      applyExtends: async () => { throw new Error('wrong operator'); },
    },
  });
  await service._applyCuratedRelationship('Updates', { fromId: 'new-1', toId: 'old-1' }, {
    factById: new Map([['new-1', { user_id: 'u1', org_id: 'o1' }]]),
    store: { createRelationship: async () => { throw new Error('direct edge write'); } },
    documentId: 'd1',
  });
  assert.deepEqual(calls[0], ['new-1', 'old-1', { user_id: 'u1', org_id: 'o1', confidence: 0.8 }]);
  await assert.rejects(
    service._applyCuratedRelationship('Derives', { fromId: 'new-1', toId: 'old-1' }, {
      factById: new Map(), store: {}, documentId: 'd1',
    }),
    /unsupported curated relationship/,
  );
});

test('unified extraction retries an empty model response without lowering admission', async () => {
  const service = Object.create(DocumentFirstIngestionService.prototype);
  service.logger = { warn() {} };
  let calls = 0;
  service._extractUnified = async () => {
    calls += 1;
    return calls === 1 ? [] : [{ f: 'Approved policy.', importance: 0.9 }];
  };
  const result = await service._extractUnifiedReliable({ content: 'source' }, {});
  assert.equal(calls, 2);
  assert.equal(result.length, 1);
});

test('unified extraction retries sparse long-document coverage and keeps the better set', async () => {
  const service = Object.create(DocumentFirstIngestionService.prototype);
  service.logger = { warn() {} };
  let calls = 0;
  service._extractUnified = async () => {
    calls += 1;
    return Array.from({ length: calls === 1 ? 2 : 3 }, (_, index) => ({ f: `Claim ${index}` }));
  };
  const result = await service._extractUnifiedReliable({ content: 'x'.repeat(800) }, { maxFacts: 6 });
  assert.equal(calls, 2);
  assert.equal(result.length, 3);
});

test('provider truncation recovers head and tail through bounded structural splits', async () => {
  const service = Object.create(DocumentFirstIngestionService.prototype);
  service.logger = { warn() {}, info() {} };
  const left = `HeadMarker approved capacity 73. ${'Head context remains grounded. '.repeat(18)}`;
  const right = `TailMarker is not compatible with diesel. ${'Tail context remains grounded. '.repeat(18)}`;
  const content = `${left}\n\n${right}`;
  const calls = [];
  service._extractUnified = async (window) => {
    calls.push(window.content);
    if (window.content === content) {
      const error = new Error('truncated');
      error.code = 'LLM_JSON_TRUNCATED';
      error.partial = { facts: [] };
      throw error;
    }
    const quote = window.content.includes('HeadMarker')
      ? 'HeadMarker approved capacity 73.' : 'TailMarker is not compatible with diesel.';
    return [{
      f: quote,
      source_quote: quote,
      source_start: 0,
      source_end: quote.length,
      memory_type: 'fact', importance: 0.9, entities: [], rels: [],
    }];
  };
  const result = await service._extractUnifiedReliable({ content }, { maxFacts: 6 });
  assert.equal(calls.length, 3, 'one original call plus two smaller recovery calls');
  assert.deepEqual(result.map((claim) => claim.f), [
    'HeadMarker approved capacity 73.',
    'TailMarker is not compatible with diesel.',
  ]);
  assert.equal(result[0].source_start, 0);
  assert.equal(result[1].source_start, content.indexOf('TailMarker'));
});

test('dense split chooses a structural boundary and preserves every source character', () => {
  const left = 'A'.repeat(420);
  const right = 'B'.repeat(430);
  const source = `${left}\n\n${right}`;
  const parts = splitDenseExtractionContent(source);
  assert.equal(parts.length, 2);
  assert.equal(parts.join('\n\n'), source);
});

test('unified promotion replaces language-code titles and rejects value entities', () => {
  const source = 'FOREST approved a 12 percent threshold on 1 August 2026.';
  const [claim] = normalizeUnifiedClaims([{
    t: 'en',
    f: source,
    memory_type: 'decision',
    source_quote: source,
    importance: 0.9,
    entities: ['FOREST', '12 percent', '1 August 2026'],
    rels: [],
  }], source, 5, 0.65);
  assert.match(claim.t, /^FOREST approved/);
  assert.deepEqual(claim.entities, ['FOREST']);
});

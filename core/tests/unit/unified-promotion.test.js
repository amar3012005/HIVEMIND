import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentFirstIngestionService, normalizeCuratedClaims, normalizeUnifiedClaims } from '../../src/knowledge/document-first-ingestion.js';

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

test('document curation merges support without losing source provenance', () => {
  const candidates = [
    { t: 'Retention', f: 'Retention is seven years.', memory_type: 'fact', importance: 0.9, entities: ['Policy'], segmentId: 's1', source_quote: 'Retention is seven years.' },
    { t: 'Owner', f: 'The compliance officer owns reviews.', memory_type: 'fact', importance: 0.82, entities: ['Compliance Officer'], segmentId: 's2', source_quote: 'The compliance officer owns reviews.' },
  ];
  const claims = normalizeCuratedClaims([{
    title: 'Retention review policy',
    content: 'Records are retained for seven years and the compliance officer owns the reviews.',
    memory_type: 'fact', importance: 0.94, support_indices: [0, 1], entities: ['Policy'],
  }], candidates, 8);

  assert.equal(claims.length, 1);
  assert.deepEqual(claims[0].support_segment_ids, ['s1', 's2']);
  assert.deepEqual(claims[0].support_quotes, [candidates[0].source_quote, candidates[1].source_quote]);
  assert.deepEqual(claims[0].entities, ['Policy', 'Compliance Officer']);
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
    entities: ['Board'],
    rels: [],
  }];

  const result = await service._ingestUnifiedWindow(
    { segmentId: 'segment-1', content: 'The board approved the launch on 15 July.' },
    { userId: 'user-1', orgId: 'org-1', documentId: 'doc-1', metadata: { scope: 'organization' }, docTitle: 'Plan' },
  );

  assert.equal(result[0].memory_type, 'decision');
  assert.equal(ingested[0].memory_type, 'decision');
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

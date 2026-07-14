import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentFirstIngestionService, normalizeUnifiedClaims } from '../../src/knowledge/document-first-ingestion.js';

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

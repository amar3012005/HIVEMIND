import test from 'node:test';
import assert from 'node:assert/strict';
import { DocumentFirstIngestionService } from '../../src/knowledge/document-first-ingestion.js';

test('Core persists hm-extract atomic segments with exact source offsets instead of rechunking', async () => {
  const source = 'Rama approved the 12000 EUR budget for Project Atlas after security review.';
  const startOffset = source.indexOf('Rama');
  const endOffset = source.length;
  const created = [];
  const service = Object.create(DocumentFirstIngestionService.prototype);
  service.db = { knowledgeSegment: { create: async ({ data }) => {
    const row = { id: `segment-${created.length + 1}`, ...data };
    created.push(row);
    return row;
  } } };
  service.logger = { warn() {} };

  const result = await service._createSegments({
    documentId: 'doc-hm-extract', userId: 'user-local', orgId: 'org-local',
    parseResult: {
      success: true,
      text: source,
      metadata: { hmExtractSegments: [{
        segmentIndex: 0, segmentType: 'paragraph', content: source,
        startOffset, endOffset, startPage: 1, endPage: 1, depth: 0,
        metadata: { heading_path: ['Budget'], source: 'hm-extract' },
      }] },
    },
    docScope: { scope: 'organization', sourceId: 'source-original' },
  });

  assert.equal(result.length, 1);
  assert.equal(created.length, 1);
  assert.equal(result[0].content, source);
  assert.equal(result[0].startOffset, startOffset);
  assert.equal(result[0].endOffset, endOffset);
  assert.equal(result[0].segmentType, 'paragraph');
  assert.deepEqual(result[0].metadata.heading_path, ['Budget']);
  assert.equal(result[0].metadata.source_id, 'source-original');
});

test('Core rejects mismatched hm-extract spans and safely falls back to the canonical chunker', async () => {
  const source = 'Rama approved the 12000 EUR budget for Project Atlas after security review.';
  const created = [];
  const service = Object.create(DocumentFirstIngestionService.prototype);
  service.db = { knowledgeSegment: { create: async ({ data }) => {
    const row = { id: `segment-${created.length + 1}`, ...data };
    created.push(row);
    return row;
  } } };
  service.logger = { warn() {} };

  const result = await service._createSegments({
    documentId: 'doc-bad-span', userId: 'user-local', orgId: 'org-local',
    parseResult: {
      success: true,
      text: source,
      metadata: { hmExtractSegments: [{
        segmentIndex: 0, segmentType: 'paragraph', content: 'not a source quote at all',
        startOffset: 0, endOffset: 25, metadata: {},
      }] },
    },
  });

  assert.ok(result.length > 0);
  assert.ok(result.every((segment) => segment.content !== 'not a source quote at all'));
});

test('Core retains short but exact parser evidence and uses UTF-16 source offsets', async () => {
  const source = '💡';
  const created = [];
  const service = Object.create(DocumentFirstIngestionService.prototype);
  service.db = { knowledgeSegment: { create: async ({ data }) => {
    const row = { id: `segment-${created.length + 1}`, ...data };
    created.push(row);
    return row;
  } } };
  service.logger = { warn() {} };

  const result = await service._createSegments({
    documentId: 'doc-short-unicode', userId: 'user-local', orgId: 'org-local',
    parseResult: {
      success: true,
      text: source,
      metadata: { hmExtractSegments: [{
        segmentIndex: 0, segmentType: 'figure', content: source,
        startOffset: 0, endOffset: 2, metadata: {},
      }] },
    },
  });

  assert.equal(result.length, 1);
  assert.equal(result[0].content, source);
  assert.equal(result[0].startOffset, 0);
  assert.equal(result[0].endOffset, 2, 'parser ranges use JavaScript UTF-16 code units');
});

test('Core trusts exact offsets for repeated text and refuses to guess missing occurrence locations', async () => {
  const repeated = 'The board approved the same resolution.';
  const source = `${repeated}\n\n${repeated}`;
  const created = [];
  const service = Object.create(DocumentFirstIngestionService.prototype);
  service.db = { knowledgeSegment: { create: async ({ data }) => {
    const row = { id: `segment-${created.length + 1}`, ...data };
    created.push(row);
    return row;
  } } };
  service.logger = { warn() {} };

  const exact = await service._createSegments({
    documentId: 'doc-repeated-exact', userId: 'user-local', orgId: 'org-local',
    parseResult: { success: true, text: source, metadata: { hmExtractSegments: [
      { segmentIndex: 0, content: repeated, startOffset: 0, endOffset: repeated.length, metadata: {} },
      { segmentIndex: 1, content: repeated, startOffset: repeated.length + 2,
        endOffset: source.length, metadata: {} },
    ] } },
  });
  assert.deepEqual(exact.map((segment) => segment.startOffset), [0, repeated.length + 2]);
  assert.ok(exact.every((segment) => source.slice(segment.startOffset, segment.endOffset) === repeated));

  created.length = 0;
  const fallback = await service._createSegments({
    documentId: 'doc-repeated-no-locations', userId: 'user-local', orgId: 'org-local',
    parseResult: { success: true, text: source, metadata: { hmExtractSegments: [
      { segmentIndex: 0, content: repeated, metadata: { source: 'hm_extract' } },
      { segmentIndex: 1, content: repeated, metadata: { source: 'hm_extract' } },
    ] } },
  });
  assert.ok(fallback.length > 0);
  assert.ok(fallback.every((segment) => segment.metadata?.source !== 'hm_extract'));
});

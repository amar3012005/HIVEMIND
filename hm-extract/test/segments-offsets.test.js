import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSegments } from '../src/segments.js';
import { findExactSegmentSpan } from '../src/segments.js';
import { chunkTextWithOffsets } from '../src/chunker.js';

test('segment offsets resolve the complete repeated text instead of a shared prefix', () => {
  const repeated = 'A repeated slide heading followed by the same complete evidence paragraph.';
  const source = `${repeated}\n${repeated}`;
  const first = findExactSegmentSpan(source, repeated, 0);
  const second = findExactSegmentSpan(source, repeated, first.start + repeated.length - 10);

  assert.deepEqual(first, { start: 0, end: repeated.length });
  assert.deepEqual(second, { start: repeated.length + 1, end: source.length });
  assert.equal(source.slice(second.start, second.end), repeated);
});

test('unmappable content receives no fabricated source range', () => {
  assert.equal(findExactSegmentSpan('source text', 'different evidence'), null);
});

test('prose chunks preserve exact source slices across paragraph boundaries and overlap', () => {
  const paragraphs = Array.from({ length: 8 }, (_, i) =>
    `Paragraph ${i + 1}. ${'Evidence remains attached to the exact original document wording. '.repeat(5)}`);
  const source = paragraphs.join('\n\n');
  const chunks = chunkTextWithOffsets(source, { targetSize: 480, maxSize: 720, minSize: 200, overlapSize: 100 });

  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.equal(source.slice(chunk.start, chunk.end), chunk.text);
  }
  assert.ok(chunks.slice(1).some((chunk, index) => chunk.start < chunks[index].end), 'expected deliberate overlap');
  for (let offset = 0; offset < source.length; offset += 1) {
    if (!/\s/u.test(source[offset])) assert.ok(chunks.some((chunk) => chunk.start <= offset && offset < chunk.end), `uncovered source offset ${offset}`);
  }
});

test('built prose, table, and list evidence all carry exact source offsets', () => {
  const prose = `Overview\n${'The exact evidence sentence stays attached to its source. '.repeat(8)}`;
  const table = [
    '| Person | Responsibility |',
    '| --- | --- |',
    '| Rama | Singapore incorporation lead |',
    '| Amar | Document preparation |',
  ].join('\n');
  const list = ['- First approved action', '- Second approved action', '- Third approved action'].join('\n');
  const source = `${prose}\n\n${table}\n\n${list}`;
  const segments = buildSegments(source, [], { targetSize: 220, overlapSize: 40 });

  assert.ok(segments.length >= 3);
  for (const segment of segments) {
    assert.ok(Number.isInteger(segment.startOffset), `${segment.segmentType} missing start offset`);
    assert.ok(Number.isInteger(segment.endOffset), `${segment.segmentType} missing end offset`);
    assert.equal(source.slice(segment.startOffset, segment.endOffset), segment.content);
  }
  assert.ok(segments.some((segment) => segment.segmentType === 'table'));
  assert.ok(segments.some((segment) => segment.segmentType === 'list'));
});

test('forced prose splits stay exact and do not lose the tail', () => {
  const source = `Lead. ${'Long uninterrupted evidence without a sentence boundary '.repeat(35)} END MARKER.`;
  const chunks = chunkTextWithOffsets(source, { targetSize: 320, maxSize: 480, minSize: 100, overlapSize: 30 });
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) assert.equal(source.slice(chunk.start, chunk.end), chunk.text);
  assert.ok(chunks.some((chunk) => chunk.text.includes('END MARKER.')));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { writeExtractResponse } from '../src/extract-response.js';

function slowResponse() {
  const response = new EventEmitter();
  response.parts = [];
  response.writes = 0;
  response.status = (code) => { response.statusCode = code; return response; };
  response.set = (key, value) => { response.headers ||= {}; response.headers[key] = value; return response; };
  response.write = (part) => {
    response.parts.push(String(part));
    response.writes += 1;
    if (response.writes % 4 === 0) {
      setImmediate(() => response.emit('drain'));
      return false;
    }
    return true;
  };
  response.end = (part = '') => { response.parts.push(String(part)); response.ended = true; };
  return response;
}

test('JSON writer honors backpressure and emits a parseable bounded-batch response', async () => {
  const response = slowResponse();
  const segments = Array.from({ length: 2_000 }, (_, index) => ({
    segmentIndex: index,
    content: `Evidence block ${index}: ${'verbatim source wording '.repeat(4)}`,
    startOffset: index * 100,
    endOffset: index * 100 + 100,
  }));
  await writeExtractResponse(response, {
    engine: 'anydoc', format: 'docx', chars: 200_000,
    markdown: 'full document text', text: 'full document text', pageMarks: [], segments,
    structuralDensity: { segment_count: segments.length }, timings: { total_ms: 1 },
  }, { compact: true });

  assert.equal(response.statusCode, 200);
  assert.equal(response.ended, true);
  assert.ok(response.writes > 4, 'test must exercise the drain path');
  const payload = JSON.parse(response.parts.join(''));
  assert.equal(payload.text, 'full document text');
  assert.equal('markdown' in payload, false, 'compact response must not serialize a duplicate text alias');
  assert.equal(payload.segments.length, segments.length);
  assert.deepEqual(payload.segments.at(-1), segments.at(-1));
});

test('legacy JSON writer keeps both text aliases for existing clients', async () => {
  const response = slowResponse();
  await writeExtractResponse(response, {
    engine: 'anydoc', format: 'rtf', chars: 8, markdown: 'same text', text: 'same text',
    pageMarks: [], segments: [], structuralDensity: {}, timings: {},
  });
  const payload = JSON.parse(response.parts.join(''));
  assert.equal(payload.markdown, payload.text);
});

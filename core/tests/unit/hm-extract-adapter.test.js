import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildLocalParserUnavailableResult,
  injectSeparatedPageMarks,
} from '../../src/knowledge/enterprise/hm-extract-adapter.js';

test('hm-extract adapter restores separated page marks without changing source text', () => {
  const source = 'Slide one\nSlide two';
  const marked = injectSeparatedPageMarks(source, [{ at: 0, page: 1 }, { at: 10, page: 2 }]);
  assert.match(marked, /<!-- page 1 -->/);
  assert.match(marked, /<!-- page 2 -->/);
  assert.equal(marked.replace(/\n<!-- page \d+ -->\n/g, ''), source);
});

test('hm-extract adapter ignores malformed page marks', () => {
  assert.equal(injectSeparatedPageMarks('source', [{ at: -1, page: 1 }, { at: 99, page: 2 }]), 'source');
});

test('Docling-disabled fallback is explicit and cannot look like successful empty extraction', () => {
  const result = buildLocalParserUnavailableResult({
    filename: 'proposal.pptx',
    hmExtractError: 'http 503',
  });

  assert.equal(result.engine, 'local-parser-unavailable');
  assert.equal(result.text, '');
  assert.deepEqual(result.hybridChunks, []);
  assert.match(result.error, /hm-extract could not parse proposal\.pptx: http 503/);
  assert.match(result.error, /Docling is disabled/);
});

test('Docling-disabled fallback reports unsupported local parser coverage', () => {
  const result = buildLocalParserUnavailableResult({ filename: 'archive.xyz' });
  assert.match(result.error, /no enabled local parser could parse archive\.xyz/);
  assert.equal(result.engine, 'local-parser-unavailable');
});

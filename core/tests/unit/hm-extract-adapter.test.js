import test from 'node:test';
import assert from 'node:assert/strict';
import { injectSeparatedPageMarks } from '../../src/knowledge/enterprise/hm-extract-adapter.js';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { injectSeparatedPageMarks, parseWithHmExtract } from '../../src/knowledge/enterprise/hm-extract-adapter.js';

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

test('Core requests compact v2 parser JSON and accepts a single text field', async () => {
  let observed;
  const text = 'Rama approved the launch budget.';
  const response = await parseWithHmExtract(Buffer.from('fixture'), 'fixture.rtf', {
    baseUrl: 'http://hm-extract.test/',
    fetchImpl: async (url, request) => {
      observed = { url, request };
      return new Response(JSON.stringify({
        ok: true, format: 'rtf', text, page_marks: [], structural_density: { segment_count: 1 },
        segments: [{ segmentIndex: 0, segmentType: 'paragraph', content: text,
          startOffset: 0, endOffset: text.length, metadata: {} }],
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });

  assert.equal(observed.url, 'http://hm-extract.test/extract');
  assert.equal(observed.request.headers.accept, 'application/vnd.hm-extract.v2+json');
  assert.equal(response.ok, true);
  assert.equal(response.text, text);
  assert.equal(response.markdown, text);
  assert.equal(response.sourceSegments[0].content, text);
  assert.equal(response.sourceSegments[0].startOffset, 0);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { storedSegmentLocators, unifiedExtractionMessages, resolveEvidenceSupport } from '../../src/knowledge/document-first-ingestion.js';

test('extraction contract and source context share exactly one system message', () => {
  const messages = unifiedExtractionMessages('Return facts with source_quote.', 'Section: Approval', 'Approval requires review.', 'Approval');
  assert.equal(messages.filter(message => message.role === 'system').length, 1);
  assert.match(messages[0].content, /Return facts with source_quote/);
  assert.match(messages[0].content, /Section: Approval/);
  assert.match(messages[1].content, /Approval requires review/);
});
test('existing whitespace-rewrapped segments receive actual page ranges without changing content', () => {
  const text = '-- 1 of 2 --\nAlpha statement.\n\nA condition applies.\n-- 2 of 2 --\nBeta deadline is tomorrow.';
  const segments = [{ id: 'a', content: 'Alpha statement.\nA condition applies.' }, { id: 'b', content: 'Beta deadline is tomorrow.' }];
  const result = storedSegmentLocators(segments, { text });
  assert.equal(result.length, 2);
  assert.deepEqual(result.map(row => row.startPage), [1, 2]);
  assert.ok(result[1].startOffset > result[0].endOffset);
  assert.equal(segments[0].content, 'Alpha statement.\nA condition applies.');
});
test('unknown source locators stay unknown rather than fabricate a page', () => {
  assert.deepEqual(storedSegmentLocators([{ id: 'x', content: 'Absent quote' }], { text: 'Unrelated source.' }), []);
});
test('cross-section exact citations keep segment ids and excerpts aligned', () => {
  const segments = [{ id: 'a', content: 'Ravi approved the plan' }, { id: 'b', content: 'only after Sofia verified the figures.' }];
  const result = resolveEvidenceSupport(segments.map(s => s.content).join('\n\n'), segments);
  assert.deepEqual(result.support_segment_ids, ['a', 'b']);
  assert.deepEqual(result.support_quotes, segments.map(s => s.content));
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mergeExtractedContent,
  normalizeUrlBackedSearchResults,
  providerCandidateRows,
} from '../../src/hyper/web-search-citations.js';

test('normalizes only unique public URL-backed citations', () => {
  const rows = normalizeUrlBackedSearchResults([
    { title: 'Solvis', url: 'https://solvis.de', description: 'First party' },
    { source: { title: 'Duplicate', url: 'https://solvis.de' } },
    { link: 'mailto:hello@example.test', text: 'not web evidence' },
    { source_url: 'https://example.org/market', text: 'Independent evidence', relevance_score: 0.8 },
  ], { limit: 6 });

  assert.deepEqual(rows, [
    { title: 'Solvis', url: 'https://solvis.de', snippet: 'First party', score: null },
    { title: 'Source 4', url: 'https://example.org/market', snippet: 'Independent evidence', score: 0.8 },
  ]);
});

test('supports Parallel source shapes and fills URL-only Composio citations', () => {
  const parallelRows = providerCandidateRows({ data: { sources: [{ name: 'Market', link: 'https://example.org' }] } });
  assert.equal(parallelRows.length, 1);
  const merged = mergeExtractedContent(
    normalizeUrlBackedSearchResults([{ url: 'https://solvis.de', title: 'Solvis' }]),
    [{ url: 'https://solvis.de', content: 'Company source text' }],
  );
  assert.equal(merged[0].snippet, 'Company source text');
});

test('does not treat provider prose without a source URL as evidence', () => {
  assert.deepEqual(normalizeUrlBackedSearchResults([{ answer: 'A confident answer' }]), []);
  assert.deepEqual(providerCandidateRows({ answer: 'A confident answer' }), []);
});

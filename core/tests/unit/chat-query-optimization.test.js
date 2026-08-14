import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fallbackRecallQueries,
  normalizeRecallOptimization,
} from '../../src/agent/chat-query-optimizer.js';

test('semantic rewrite stays first and preserves a requested small detail', () => {
  const fallback = fallbackRecallQueries('What was the brand of my handbag?', {
    query_canonical_en: 'handbag brand',
    sub_queries: ['handbag'],
  });
  const queries = normalizeRecallOptimization({
    semantic_query: 'brand associated with the user handbag',
    queries: ['Handtaschenmarke des Benutzers'],
  }, fallback);

  assert.deepEqual(queries, [
    'brand associated with the user handbag',
    'handbag brand',
    'What was the brand of my handbag?',
  ]);
  assert.notEqual(queries[0], 'handbag');
});

test('optimizer fallback preserves planner intent instead of language-bound keyword stripping', () => {
  assert.deepEqual(fallbackRecallQueries('Was haben wir gestern beschlossen?', {
    query_canonical_en: 'decisions made yesterday',
    sub_queries: ['yesterday decisions', 'meeting decisions yesterday'],
  }), [
    'decisions made yesterday',
    'Was haben wir gestern beschlossen?',
    'yesterday decisions',
  ]);
});

test('untrusted alternate rewrites cannot weaken negation or direction', () => {
  assert.deepEqual(normalizeRecallOptimization({
    semantic_query: 'decisions not approved by Amar in the latest pitch deck',
    queries: ['pitch deck decisions approved by Amar'],
  }, ['pitch deck decisions', 'What decisions were not approved by Amar?']), [
    'decisions not approved by Amar in the latest pitch deck',
    'pitch deck decisions',
    'What decisions were not approved by Amar?',
  ]);
});

test('semantic normalization retains negation, source, relation, and time qualifiers verbatim', () => {
  const specific = 'decisions not approved by Amar in the pitch deck during the last seven days';
  assert.equal(normalizeRecallOptimization({ semantic_query: specific, queries: [] }, ['decisions'])[0], specific);
});

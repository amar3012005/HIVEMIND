import test from 'node:test';
import assert from 'node:assert/strict';
import { applyExactSourceSummaryPenalty, sortWithImportanceTiebreaker } from '../../src/memory/recall-ranking-policy.js';
import { boundedLaneFusion } from '../../src/memory/persisted-retrieval.js';

test('importance breaks ties inside a relevance band', () => {
  const result = sortWithImportanceTiebreaker([
    { score: 0.99, memory: { id: 'low', importance_score: 0.2 } },
    { score: 0.98, memory: { id: 'high', importance_score: 0.9 } },
  ]);
  assert.deepEqual(result.map((item) => item.memory.id), ['high', 'low']);
});

test('importance never admits a materially less relevant candidate', () => {
  const result = sortWithImportanceTiebreaker([
    { score: 1, memory: { id: 'relevant', importance_score: 0.1 } },
    { score: 0.7, memory: { id: 'important', importance_score: 1 } },
  ]);
  assert.deepEqual(result.map((item) => item.memory.id), ['relevant', 'important']);
});

test('exact-source questions demote summaries but preserve direct facts', () => {
  const summary = applyExactSourceSummaryPenalty({
    score: 1,
    memory: { memory_type: 'summary', tags: ['canonical-summary'] },
  }, true);
  const fact = applyExactSourceSummaryPenalty({
    score: 1,
    memory: { memory_type: 'fact', tags: ['distilled-from-kb'] },
  }, true);
  assert.equal(summary.score, 0.72);
  assert.equal(fact.score, 1);
});

test('multi-lane candidate fusion is globally bounded and preserves lane diversity', () => {
  const lane = (prefix) => Array.from({ length: 150 }, (_, index) => ({ memory: { id: `${prefix}-${index}` } }));
  const fused = boundedLaneFusion([lane('vector'), lane('lexical'), lane('entity')]);
  assert.equal(fused.length, 150);
  assert.deepEqual(fused.slice(0, 3).map((item) => item.memory.id), ['vector-0', 'lexical-0', 'entity-0']);
});

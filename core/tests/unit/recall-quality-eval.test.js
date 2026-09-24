import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateRecallQuality } from '../../scripts/eval-recall-quality.mjs';

test('recall quality gate requires no lost evidence, no unauthorized results, and bounded latency', () => {
  const row = { query: 'Rama Singapore incorporation', expected_ids: ['a'], authorized_ids: ['a', 'b'],
    baseline_ids: ['b', 'a'], candidate_ids: ['a', 'b'], baseline_latency_ms: 100, candidate_latency_ms: 110 };
  assert.equal(evaluateRecallQuality([row]).passed, true);
  assert.equal(evaluateRecallQuality([{ ...row, candidate_ids: ['b'] }]).passed, false);
  assert.equal(evaluateRecallQuality([{ ...row, candidate_ids: ['a', 'other'] }]).passed, false);
  assert.equal(evaluateRecallQuality([{ ...row, candidate_latency_ms: 140 }]).passed, false);
});

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { detectQueryIntent, computeDynamicWeights } from '../../src/memory/operator-layer.js';

describe('detectQueryIntent', () => {
  it('treats weekday and quarter queries as temporal', () => {
    const intent = detectQueryIntent('what changed last Tuesday in Q1 2026?');

    assert.equal(intent.type, 'temporal');
    assert.ok(intent.timeReferences.some((ref) => /tuesday|q1/i.test(ref)), `Expected temporal references in ${intent.timeReferences.join(', ')}`);

    const weights = computeDynamicWeights(intent);
    assert.ok(weights.recency > 0.25, `Expected temporal intent to boost recency, got ${weights.recency}`);
  });
});

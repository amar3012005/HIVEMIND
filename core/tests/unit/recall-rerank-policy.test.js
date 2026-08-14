import test from 'node:test';
import assert from 'node:assert/strict';
import { initialMemoryCrossRerank } from '../../src/memory/recall-rerank-policy.js';

test('unified delivery suppresses the discarded memory-only cross-encoder pass', () => {
  assert.equal(initialMemoryCrossRerank({
    laterAuthoritativeOrdering: true,
    requested: true,
  }), false);
});

test('memory-only retrieval retains its explicit or environment-owned policy', () => {
  assert.equal(initialMemoryCrossRerank({
    laterAuthoritativeOrdering: false,
    requested: true,
  }), true);
  assert.equal(initialMemoryCrossRerank({
    laterAuthoritativeOrdering: false,
    requested: false,
  }), false);
  assert.equal(initialMemoryCrossRerank({
    laterAuthoritativeOrdering: false,
  }), null);
});

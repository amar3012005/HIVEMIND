import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isValidEmbeddingVector,
  validateEmbeddingRows,
  validateEmbeddingVector,
} from '../../src/embeddings/vector-contract.js';

test('embedding vector contract rejects missing, short, and non-finite vectors', () => {
  assert.throws(() => validateEmbeddingVector(null, { dimension: 3 }), /not an array/);
  assert.throws(() => validateEmbeddingVector([1, 2], { dimension: 3 }), /dim=2, want 3/);
  assert.throws(() => validateEmbeddingVector([1, Number.NaN, 3], { dimension: 3 }), /non-finite/);
  assert.equal(isValidEmbeddingVector([1, 2, 3], { dimension: 3 }), true);
  assert.equal(isValidEmbeddingVector([], { dimension: 3 }), false);
});

test('embedding row contract preserves exact input alignment', () => {
  assert.deepEqual(validateEmbeddingRows([[1, 2], [3, 4]], 2, { dimension: 2 }), [[1, 2], [3, 4]]);
  assert.throws(() => validateEmbeddingRows([[1, 2]], 2, { dimension: 2 }), /row count=1, want 2/);
});

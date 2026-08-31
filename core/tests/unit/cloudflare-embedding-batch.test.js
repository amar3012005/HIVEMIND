import test from 'node:test';
import assert from 'node:assert/strict';
import { cloudflareEmbeddingBatches } from '../../src/embeddings/cloudflare-workers-ai.js';

test('Cloudflare embeddings stay below both item and character request budgets', () => {
  const texts = Array.from({ length: 100 }, (_, index) => `${index}:`.padEnd(1_003, 'x'));
  const batches = cloudflareEmbeddingBatches(texts, { maxItems: 48, maxChars: 45_000 });

  assert.deepEqual(batches.map((batch) => batch.length), [44, 44, 12]);
  assert.equal(batches.flat().length, texts.length);
  assert.deepEqual(batches.flat(), texts);
  assert.ok(batches.every((batch) => batch.length <= 48));
  assert.ok(batches.every((batch) => batch.reduce((sum, text) => sum + text.length, 0) <= 45_000));
});

test('Cloudflare embeddings preserve one oversized canonical segment as one row', () => {
  const batches = cloudflareEmbeddingBatches(['x'.repeat(50_000), 'tail'], { maxChars: 45_000 });
  assert.deepEqual(batches.map((batch) => batch.length), [1, 1]);
});

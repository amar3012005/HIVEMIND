import test from 'node:test';
import assert from 'node:assert/strict';
import { ResultReranker } from '../../src/search/result-reranker.js';

test('algorithmic reranking tolerates structured stored content', () => {
  const reranker = new ResultReranker();
  assert.doesNotThrow(() => reranker.rerank('Kruti', [
    { id: 'structured', content: { text: 'Kruti was mentioned here.' }, score: 0.5 },
  ]));
});

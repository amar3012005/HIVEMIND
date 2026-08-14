import test from 'node:test';
import assert from 'node:assert/strict';

import { warmUpReranker } from '../../src/memory/reranker.js';

test('reranker warm-up skips cleanly when cross-encoder is disabled', async () => {
  let calls = 0;
  const result = await warmUpReranker({
    enabled: false,
    run: async () => { calls += 1; return []; },
  });

  assert.deepEqual(result, { ok: false, skipped: true });
  assert.equal(calls, 0);
});

test('reranker warm-up reaches provider with synthetic data and coalesces callers', async () => {
  let calls = 0;
  let release;
  const blocked = new Promise((resolve) => { release = resolve; });
  const run = async (query, candidates, options) => {
    calls += 1;
    assert.equal(query, 'hivemind retrieval readiness probe');
    assert.equal(candidates.length, 2);
    assert.equal(options.topN, 1);
    await blocked;
    return [{ ...candidates[0], rerank_score: 0.99 }];
  };

  const first = warmUpReranker({ enabled: true, run });
  const second = warmUpReranker({ enabled: true, run });
  assert.equal(calls, 1);
  release();

  assert.deepEqual(await first, { ok: true, skipped: false });
  assert.deepEqual(await second, { ok: true, skipped: false });
  assert.equal(calls, 1);
});

test('reranker warm-up reports provider degradation honestly', async () => {
  const result = await warmUpReranker({
    enabled: true,
    run: async () => [{ id: 'fallback-without-cross-score' }],
  });

  assert.deepEqual(result, { ok: false, skipped: false });
});

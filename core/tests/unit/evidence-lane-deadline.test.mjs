import assert from 'node:assert/strict';
import test from 'node:test';
import { settleEvidenceLaneWithin } from '../../src/knowledge/evidence-lane-deadline.js';

test('a completed lexical lane is not held behind a slow semantic lane', async () => {
  const started = Date.now();
  const slowVector = new Promise((resolve) => setTimeout(() => resolve(['semantic']), 100));
  const fastLexical = Promise.resolve(['lexical']);
  const [vector, lexical] = await Promise.all([
    settleEvidenceLaneWithin(slowVector, 15, null),
    settleEvidenceLaneWithin(fastLexical, 15, null),
  ]);
  assert.equal(vector, null);
  assert.deepEqual(lexical, ['lexical']);
  assert.ok(Date.now() - started < 80);
});

test('late rejection is consumed after a lane timeout', async () => {
  const lateFailure = new Promise((resolve, reject) => setTimeout(() => reject(new Error('late')), 30));
  assert.equal(await settleEvidenceLaneWithin(lateFailure, 5, null), null);
  await new Promise((resolve) => setTimeout(resolve, 40));
});

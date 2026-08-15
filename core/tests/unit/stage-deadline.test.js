import assert from 'node:assert/strict';
import test from 'node:test';
import { getMaxListeners } from 'node:events';

import {
  StageDeadlineError,
  currentStageSignal,
  remainingStageMs,
  runWithStageDeadline,
} from '../../src/runtime/stage-deadline.js';

test('a timed-out stage aborts cooperative work before returning its fallback', async () => {
  let observedAbort = false;
  const startedAt = Date.now();
  const result = await runWithStageDeadline(async ({ signal }) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve('late'), 500);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      observedAbort = true;
      reject(signal.reason);
    }, { once: true });
  }), {
    timeoutMs: 35,
    fallback: 'bounded',
    label: 'deadline-test',
  });

  assert.equal(result, 'bounded');
  assert.equal(observedAbort, true);
  assert.ok(Date.now() - startedAt < 150);
});

test('nested stages inherit the earliest deadline and expose it through async context', async () => {
  const result = await runWithStageDeadline(async () => {
    assert.ok(currentStageSignal());
    assert.ok(remainingStageMs(5_000) <= 80);
    return runWithStageDeadline(async () => ({
      hasSignal: Boolean(currentStageSignal()),
      remainingMs: remainingStageMs(5_000),
    }), { timeoutMs: 500, label: 'nested' });
  }, { timeoutMs: 45, fallback: 'outer-bounded', label: 'outer' });

  assert.equal(result.hasSignal, true);
  assert.ok(result.remainingMs <= 45);
});

test('deadline errors remain typed for callers that require fail-closed behavior', async () => {
  await assert.rejects(
    runWithStageDeadline(async ({ signal }) => new Promise((_, reject) => {
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }), { timeoutMs: 20, label: 'strict-stage' }),
    (error) => error instanceof StageDeadlineError && error.code === 'STAGE_DEADLINE_EXCEEDED',
  );
});

test('a stage signal supports the bounded recall fan-out without disabling leak detection', async () => {
  const limit = await runWithStageDeadline(async ({ signal }) => getMaxListeners(signal), {
    timeoutMs: 100,
    label: 'fanout-listener-budget',
  });

  assert.ok(limit >= 16);
  assert.ok(Number.isFinite(limit));
});

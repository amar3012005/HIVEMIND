import test from 'node:test';
import assert from 'node:assert/strict';
import { replayRuntimeTrace, runtimeProjection } from '../../src/hq-runtime/replay-harness.js';

test('Runtime replay harness checks the durable projection after each persisted input', async () => {
  const events = [];
  const trace = {
    id: 'noisy-wake-baseline',
    steps: [
      { input: { type: 'wake', id: 'wake-1' }, expected: { events: [{ id: 'event-1', type: 'wake_received', sequence: '1', visibility: 'USER' }], schedules: [], runs: [], todos: [] } },
      { input: { type: 'wake', id: 'wake-1' }, expected: { events: [{ id: 'event-1', type: 'wake_received', sequence: '1', visibility: 'USER' }], schedules: [], runs: [], todos: [] } },
    ],
  };
  const replay = await replayRuntimeTrace({
    trace,
    applyInput: async (input) => {
      if (!events.length) events.push({ id: 'event-1', eventType: 'wake_received', sequence: 1, visibility: 'USER' });
      return input;
    },
    readProjection: async () => runtimeProjection({ events }),
  });
  assert.equal(replay.steps.length, 2);
  assert.equal(replay.steps[1].projection.events.length, 1);
});

test('Runtime replay harness rejects a trace when a durable projection diverges', async () => {
  await assert.rejects(() => replayRuntimeTrace({
    trace: { steps: [{ input: { type: 'wake' }, expected: { events: [], schedules: [], runs: [], todos: [] } }] },
    applyInput: async () => null,
    readProjection: async () => runtimeProjection({ events: [{ id: 'unexpected', eventType: 'wake_received', sequence: 1, visibility: 'USER' }] }),
  }), /runtime replay step 1 diverged/);
});

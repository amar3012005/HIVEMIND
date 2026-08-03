import test from 'node:test';
import assert from 'node:assert/strict';

import {
  closeHqRuntimeEventBus,
  publishHqRuntimeEvent,
  publishHqRuntimeTransient,
  subscribeHqRuntimeEvents,
} from '../../src/hq-runtime/event-bus.js';

test('Runtime event bus fans out one durable sequence without polling', async () => {
  const received = [];
  const unsubscribe = await subscribeHqRuntimeEvents('runtime-1', (event) => received.push(event));
  await publishHqRuntimeEvent({
    runtimeId: 'runtime-1',
    orgId: 'org-1',
    sequence: 42n,
    eventType: 'decision',
    title: 'Persisted decision',
    createdAt: new Date('2026-08-03T12:00:00.000Z'),
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].sequence, '42');
  assert.equal(received[0].event.sequence, '42');
  assert.equal(received[0].event.createdAt, '2026-08-03T12:00:00.000Z');

  await unsubscribe();
  await closeHqRuntimeEventBus();
});

test('Runtime event bus carries transient model deltas without a durable cursor', async () => {
  const received = [];
  const unsubscribe = await subscribeHqRuntimeEvents('runtime-stream', (event) => received.push(event));
  await publishHqRuntimeTransient({
    runtimeId: 'runtime-stream', orgId: 'org-1',
    event: { type: 'model_stream', phase: 'delta', stream_id: 'awakening:1', delta: 'Hello' },
  });

  assert.equal(received.length, 1);
  assert.equal(received[0].transient, true);
  assert.equal(received[0].sequence, undefined);
  assert.equal(received[0].event.delta, 'Hello');

  await unsubscribe();
  await closeHqRuntimeEventBus();
});

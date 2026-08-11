import test from 'node:test';
import assert from 'node:assert/strict';
import {
  publishTurnError,
  publishTurnEvent,
  publishTurnSeal,
  subscribeTurnStream,
} from '../../src/realtime/hyper-turn-events.js';

test('hyper turn events fan out appended events to subscribers', async () => {
  const seen = [];
  const unsubscribe = subscribeTurnStream('turn-a', {
    onEvent: (evt, index) => seen.push({ evt, index }),
  });

  try {
    publishTurnEvent('turn-a', { t: 'router_bootstrap', ok: true }, 0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(seen.length, 1);
    assert.equal(seen[0].evt.t, 'router_bootstrap');
    assert.equal(seen[0].index, 0);
  } finally {
    unsubscribe();
  }
});

test('hyper turn events shared poller replays missed lines once for subscribers', async () => {
  let calls = 0;
  const seen = [];
  const unsubscribe = subscribeTurnStream('turn-b', {
    onEvent: (evt, index) => seen.push({ evt, index }),
  }, {
    lastLineCount: 0,
    fetchTurn: async () => {
      calls += 1;
      if (calls === 1) {
        return { lines: [{ t: 'router_bootstrap' }, { t: 'typing' }], status: 'live', sealedAt: null };
      }
      return { lines: [{ t: 'router_bootstrap' }, { t: 'typing' }], status: 'complete', sealedAt: new Date().toISOString() };
    },
  });

  try {
    await new Promise((resolve) => setTimeout(resolve, 2300));
    assert.equal(calls >= 1, true);
    assert.equal(seen.length >= 2, true);
    assert.equal(seen[0].index, 0);
    assert.equal(seen[1].index, 1);
  } finally {
    unsubscribe();
  }
});

test('hyper turn events deliver error and seal signals', async () => {
  let sealed = false;
  let errored = false;
  const unsubscribe = subscribeTurnStream('turn-c', {
    onSeal: () => { sealed = true; },
    onError: () => { errored = true; },
  });

  try {
    publishTurnError('turn-c', { message: 'boom' });
    publishTurnSeal('turn-c', { status: 'complete' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(errored, true);
    assert.equal(sealed, true);
  } finally {
    unsubscribe();
  }
});

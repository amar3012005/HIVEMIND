import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileHyperTurnEventOutbox,
  reconcileStrandedWorkRoomTurns,
  failDeadTurns,
} from '../../src/employees/hyper-rooms.js';

test('outbox reconciliation appends an undelivered event exactly once', async () => {
  const appended = [];
  const updates = [];
  const prisma = {
    $queryRawUnsafe: async () => [{
      id: 'outbox-1', turn_id: 'turn-1',
      event: { t: 'line', event_id: 'event-1', content: 'durable result' },
    }],
    $executeRawUnsafe: async (...args) => { updates.push(args); },
    $transaction: async (fn) => fn({
      hyperTurn: {
        findUnique: async () => ({ lines: appended }),
        update: async ({ data }) => { appended.splice(0, appended.length, ...data.lines); },
      },
    }),
  };
  const count = await reconcileHyperTurnEventOutbox(prisma);
  assert.equal(count, 1);
  assert.equal(appended.filter((event) => event.event_id === 'event-1').length, 1);
  assert.equal(updates.length >= 1, true);
});

test('stranded work room seals from its durable candidate without rerunning agents', async () => {
  const lines = [];
  let sealed = null;
  let query = 0;
  const prisma = {
    $queryRawUnsafe: async () => (++query === 1 ? [{
      id: 'turn-1', candidate_output: { content: 'Recovered useful answer' },
      verification_verdict: {}, cost_tokens: 42,
    }] : []),
    $executeRawUnsafe: async () => {},
    $transaction: async (fn) => fn({
      hyperTurn: {
        findUnique: async () => ({ lines }),
        update: async ({ data }) => { lines.splice(0, lines.length, ...data.lines); },
      },
    }),
    hyperTurn: {
      findUnique: async () => ({ sealedAt: null, lines }),
      update: async ({ data }) => { sealed = data; },
    },
  };
  const count = await reconcileStrandedWorkRoomTurns(prisma);
  assert.equal(count, 1);
  assert.equal(sealed.status, 'complete');
  assert.equal(lines.some((event) => event.recovered_from === 'candidate_output'), true);
});

// The real gap neither reconciler above covers: hm-employees restarts
// mid-turn (e.g. mid-deploy) for a turn that already streamed some lines but
// produced no durable checkpoint and no synthesis line. That turn would sit
// status='live' forever with no seal and no error, spinning the FE
// indefinitely. failDeadTurns marks it FAILED, honestly, instead.
test('a turn with no recoverable checkpoint is marked failed, not left hanging', async () => {
  const lines = [];
  let sealed = null;
  let terminalReasonSet = false;
  let query = 0;
  const prisma = {
    $queryRawUnsafe: async () => (++query === 1 ? [{ id: 'turn-dead' }] : []),
    $executeRawUnsafe: async (sql) => {
      if (String(sql).includes('terminal_reason')) terminalReasonSet = true;
    },
    $transaction: async (fn) => fn({
      hyperTurn: {
        findUnique: async () => ({ lines }),
        update: async ({ data }) => { lines.splice(0, lines.length, ...data.lines); },
      },
    }),
    hyperTurn: {
      findUnique: async () => ({ sealedAt: null, lines }),
      update: async ({ data }) => { sealed = data; },
    },
  };
  const count = await failDeadTurns(prisma);
  assert.equal(count, 1);
  assert.equal(sealed.status, 'failed');
  assert.equal(terminalReasonSet, true);
});

test('failDeadTurns is a no-op when nothing qualifies', async () => {
  const prisma = { $queryRawUnsafe: async () => [] };
  const count = await failDeadTurns(prisma);
  assert.equal(count, 0);
});

test('a failed query never throws — returns 0, not an unhandled rejection', async () => {
  const prisma = { $queryRawUnsafe: async () => { throw new Error('table missing'); } };
  const count = await failDeadTurns(prisma);
  assert.equal(count, 0);
});

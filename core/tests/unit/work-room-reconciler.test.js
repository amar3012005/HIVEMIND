import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reconcileHyperTurnEventOutbox,
  reconcileStrandedWorkRoomTurns,
  failDeadTurns,
  notifyOwningHqRuntime,
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

// Ops visibility (2026-08-16): a Work Room turn that dies or recovers used
// to be visible only in a devops console.warn — the owning HQ runtime's own
// terminal never learned. notifyOwningHqRuntime resolves
// HyperTurn.runtime_playbook_run_id -> RuntimePlaybookRun.trigger.todo_id ->
// HqTodo.runtimeId and narrates via the existing appendHqEvent log.
test('notifyOwningHqRuntime narrates a failed turn into the owning HQ runtime event log', async () => {
  const appended = [];
  const prisma = {
    runtimePlaybookRun: {
      findUnique: async ({ where }) => (where.id === 'run-1' ? { orgId: 'org-1', trigger: { todo_id: 'todo-1' } } : null),
    },
    hqTodo: {
      findFirst: async ({ where }) => (where.id === 'todo-1' && where.orgId === 'org-1'
        ? { id: 'todo-1', runtimeId: 'runtime-1', title: 'Find clients in New York' } : null),
    },
  };
  const ok = await notifyOwningHqRuntime(prisma, {
    runtimePlaybookRunId: 'run-1', turnId: 'turn-1', outcome: 'failed',
  }, { appendEvent: async (input) => { appended.push(input); } });
  assert.equal(ok, true);
  assert.equal(appended.length, 1);
  assert.equal(appended[0].runtimeId, 'runtime-1');
  assert.equal(appended[0].orgId, 'org-1');
  assert.equal(appended[0].eventType, 'blocked');
  assert.match(appended[0].title, /Find clients in New York/);
  assert.equal(appended[0].details.turn_id, 'turn-1');
});

test('notifyOwningHqRuntime narrates a recovered turn as an observation, not a blocker', async () => {
  const appended = [];
  const prisma = {
    runtimePlaybookRun: { findUnique: async () => ({ orgId: 'org-1', trigger: { todo_id: 'todo-1' } }) },
    hqTodo: { findFirst: async () => ({ id: 'todo-1', runtimeId: 'runtime-1', title: 'Draft the campaign brief' }) },
  };
  await notifyOwningHqRuntime(prisma, {
    runtimePlaybookRunId: 'run-1', turnId: 'turn-1', outcome: 'recovered',
  }, { appendEvent: async (input) => { appended.push(input); } });
  assert.equal(appended[0].eventType, 'observation');
});

test('notifyOwningHqRuntime is a silent no-op for a turn with no runtime_playbook_run_id — not HQ-owned work', async () => {
  const appendEvent = async () => { throw new Error('must never be called'); };
  assert.equal(await notifyOwningHqRuntime(null, { runtimePlaybookRunId: null }, { appendEvent }), false);
  assert.equal(await notifyOwningHqRuntime({}, {}, { appendEvent }), false);
});

test('notifyOwningHqRuntime never throws when the run or todo cannot be resolved', async () => {
  const prisma = { runtimePlaybookRun: { findUnique: async () => null } };
  assert.equal(await notifyOwningHqRuntime(prisma, { runtimePlaybookRunId: 'run-missing' }), false);
  const prismaNoTodo = {
    runtimePlaybookRun: { findUnique: async () => ({ orgId: 'org-1', trigger: { todo_id: 'todo-gone' } }) },
    hqTodo: { findFirst: async () => null },
  };
  assert.equal(await notifyOwningHqRuntime(prismaNoTodo, { runtimePlaybookRunId: 'run-1' }), false);
});

test('notifyOwningHqRuntime never throws even when appendEvent itself fails — narration must never break the reconciler', async () => {
  const prisma = {
    runtimePlaybookRun: { findUnique: async () => ({ orgId: 'org-1', trigger: { todo_id: 'todo-1' } }) },
    hqTodo: { findFirst: async () => ({ id: 'todo-1', runtimeId: 'runtime-1', title: 'X' }) },
  };
  const ok = await notifyOwningHqRuntime(prisma, { runtimePlaybookRunId: 'run-1' }, {
    appendEvent: async () => { throw new Error('epoch conflict'); },
  });
  assert.equal(ok, false);
});

test('failDeadTurns narrates the failure into the owning HQ runtime when the turn is HQ-dispatched', async () => {
  const notified = [];
  const prisma = {
    $queryRawUnsafe: async () => [{ id: 'turn-dead', runtime_playbook_run_id: 'run-1' }],
    $executeRawUnsafe: async () => {},
    $transaction: async (fn) => fn({ hyperTurn: { findUnique: async () => ({ lines: [] }), update: async () => {} } }),
    hyperTurn: { findUnique: async () => ({ sealedAt: null, lines: [] }), update: async () => {} },
  };
  const notify = async (_prisma, input) => { notified.push(input); };
  const count = await failDeadTurns(prisma, { notify });
  assert.equal(count, 1);
  assert.deepEqual(notified, [{ runtimePlaybookRunId: 'run-1', turnId: 'turn-dead', outcome: 'failed' }]);
});

test('reconcileStrandedWorkRoomTurns narrates the recovery into the owning HQ runtime when HQ-dispatched', async () => {
  const notified = [];
  let query = 0;
  const prisma = {
    $queryRawUnsafe: async () => (++query === 1 ? [{
      id: 'turn-1', candidate_output: { content: 'Recovered' }, verification_verdict: {}, cost_tokens: 10,
      runtime_playbook_run_id: 'run-1',
    }] : []),
    $executeRawUnsafe: async () => {},
    $transaction: async (fn) => fn({ hyperTurn: { findUnique: async () => ({ lines: [] }), update: async () => {} } }),
    hyperTurn: { findUnique: async () => ({ sealedAt: null, lines: [] }), update: async () => {} },
  };
  const notify = async (_prisma, input) => { notified.push(input); };
  const count = await reconcileStrandedWorkRoomTurns(prisma, { notify });
  assert.equal(count, 1);
  assert.deepEqual(notified, [{ runtimePlaybookRunId: 'run-1', turnId: 'turn-1', outcome: 'recovered' }]);
});

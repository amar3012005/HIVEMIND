import assert from 'node:assert/strict';
import test from 'node:test';
import { createWorkRunSchedule, nextDailyRunAt, normalizeWorkRunScheduleInput, runDueWorkRunSchedule } from '../../src/employees/work-run-schedules.js';

const roomId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const orgId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const userId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const scheduleId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const runId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

test('daily midnight follows Berlin wall clock over DST', () => {
  assert.equal(nextDailyRunAt('00:00', 'Europe/Berlin', new Date('2026-03-28T23:30:00Z')).toISOString(), '2026-03-29T22:00:00.000Z');
  assert.equal(nextDailyRunAt('00:00', 'Europe/Berlin', new Date('2026-10-24T22:30:00Z')).toISOString(), '2026-10-25T23:00:00.000Z');
  assert.throws(() => nextDailyRunAt('25:00', 'Europe/Berlin'), /HH:mm/);
});

test('schedule contract requires room, employee, format and future time', () => {
  const now = new Date('2026-09-29T12:00:00Z');
  const input = normalizeWorkRunScheduleInput({ room_id: roomId, goal: 'Make report', agent_slug: 'ravi', output_format: 'pdf', cadence: 'daily', timezone: 'Europe/Berlin', time: '00:00' }, now);
  assert.equal(input.nextRunAt.toISOString(), '2026-09-29T22:00:00.000Z');
  assert.throws(() => normalizeWorkRunScheduleInput({ room_id: roomId, goal: 'Make report', agent_slug: 'ravi', output_format: 'pdf', cadence: 'once', at: '2026-09-29T10:00:00Z' }, now), /future/);
});

test('create schedule checks active member, owned room and assigned employee', async () => {
  const prisma = {
    userOrganization: { findUnique: async () => ({ isActive: true }) },
    hyperRoom: { findFirst: async () => ({ id: roomId }) },
    digitalEmployee: { findFirst: async () => ({ id: 'employee' }) },
    $queryRawUnsafe: async (sql, ...args) => {
      assert.match(sql, /INSERT INTO "hivemind"\."work_run_schedules"/);
      assert.equal(args[0], orgId);
      assert.equal(args[2], roomId);
      assert.equal(args[8], 'pdf');
      return [{ id: scheduleId }];
    },
  };
  const created = await createWorkRunSchedule({ prisma, orgId, userId,
    body: { room_id: roomId, goal: 'Make report', agent_slug: 'ravi', output_format: 'pdf', cadence: 'once', at: '2026-09-30T00:00:00Z' },
    now: new Date('2026-09-29T00:00:00Z'),
  });
  assert.equal(created.id, scheduleId);
});

test('due trigger dispatches once with stable key, selected persona and PDF contract', async () => {
  const due = new Date('2026-09-29T22:00:00Z');
  const schedule = { id: scheduleId, org_id: orgId, user_id: userId, room_id: roomId,
    goal: 'Produce report', instructions: 'Use official sources', agent_slug: 'ravi',
    playbook_id: 'global:market-research', scope: {}, output_format: 'pdf', cadence: 'daily',
    timezone: 'Europe/Berlin', local_time: '00:00', next_run_at: due, failure_count: 0 };
  const releases = [];
  let claimed = false;
  const prisma = {
    $queryRawUnsafe: async (sql, ...args) => {
      if (sql.startsWith('WITH candidate')) { if (claimed) return []; claimed = true; return [schedule]; }
      if (sql.startsWith('UPDATE "hivemind"."work_run_schedules"')) { releases.push(args); return [{ id: scheduleId }]; }
      throw new Error(`unexpected SQL ${sql}`);
    },
    userOrganization: { findUnique: async () => ({ isActive: true }) },
    hyperRoom: { findFirst: async () => ({ id: roomId }) },
    digitalEmployee: { findFirst: async () => ({ id: 'employee' }) },
  };
  const calls = [];
  const dispatch = async (input) => { calls.push(input); return { workRun: { id: runId, status: 'running' } }; };
  const result = await runDueWorkRunSchedule({ prisma, now: new Date('2026-09-29T22:00:01Z'), dispatch, owner: 'test' });
  assert.equal(result.status, 'dispatched');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].hyperagentSlug, 'ravi');
  assert.equal(calls[0].completionContract.artifact_content_type, 'application/pdf');
  assert.match(calls[0].goal, /Use official sources/);
  assert.match(calls[0].triggerKey, /^[a-f0-9]{64}$/);
  assert.equal(releases[0][2], 'active');
  assert.equal(new Date(releases[0][3]).toISOString(), '2026-09-30T22:00:00.000Z');
});

test('inactive scheduled owner never dispatches and repeated failures pause trigger', async () => {
  const releases = [];
  const prisma = {
    $queryRawUnsafe: async (sql, ...args) => {
      if (sql.startsWith('WITH candidate')) return [{ id: scheduleId, org_id: orgId, user_id: userId,
        room_id: roomId, next_run_at: new Date('2026-09-29T22:00:00Z'), failure_count: 2 }];
      if (sql.startsWith('UPDATE "hivemind"."work_run_schedules"')) { releases.push(args); return [{ id: scheduleId }]; }
      throw new Error(`unexpected SQL ${sql}`);
    },
    userOrganization: { findUnique: async () => ({ isActive: false }) },
    hyperRoom: { findFirst: async () => ({ id: roomId }) },
    digitalEmployee: { findFirst: async () => ({ id: 'employee' }) },
  };
  const result = await runDueWorkRunSchedule({ prisma, dispatch: () => { throw new Error('must not dispatch'); }, owner: 'test', logger: { warn() {} } });
  assert.equal(result.status, 'paused');
  assert.equal(releases[0][2], 'paused');
});

test('retry waits before claiming same occurrence again', async () => {
  const now = new Date('2026-09-29T22:00:00Z');
  const releases = [];
  const prisma = {
    $queryRawUnsafe: async (sql, ...args) => {
      if (sql.startsWith('WITH candidate')) return [{ id: scheduleId, org_id: orgId, user_id: userId,
        room_id: roomId, next_run_at: now, failure_count: 0 }];
      releases.push(args); return [{ id: scheduleId }];
    },
    userOrganization: { findUnique: async () => ({ isActive: false }) },
    hyperRoom: { findFirst: async () => ({ id: roomId }) },
    digitalEmployee: { findFirst: async () => ({ id: 'employee' }) },
  };
  const result = await runDueWorkRunSchedule({ prisma, now, owner: 'test', logger: { warn() {} } });
  assert.equal(result.status, 'retry');
  assert.equal(releases[0][7].toISOString(), '2026-09-29T22:01:00.000Z');
});

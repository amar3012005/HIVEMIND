import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ROUTINE_STATUS,
  canTransitionRoutine,
  nativeScheduleProjection,
  normalizeRoutineInput,
  routineFireKey,
  routineWorkRunScope,
} from '../../src/employees/routines.js';
import { claimRoutineFire, createRoutine, setRoutineStatus } from '../../src/employees/routine-repository.js';

const routine = {
  room_id: 'room-1',
  agent_runtime_id: 'agent-1',
  playbook_id: 'global:brief',
  playbook_version: 2,
  goal: 'Prepare the operating brief',
  schedule_type: 'cron',
  schedule_expression: '0 * * * *',
  timezone: 'Europe/Berlin',
  authority_policy: { external_writes: 'approval' },
};

test('routine lifecycle allows pause/resume but not resurrection after archive', () => {
  assert.equal(canTransitionRoutine('active', 'paused'), true);
  assert.equal(canTransitionRoutine('paused', 'active'), true);
  assert.equal(canTransitionRoutine('archived', 'active'), false);
});

test('routine input normalizes and rejects invalid playbook versions', () => {
  assert.equal(normalizeRoutineInput(routine).status, ROUTINE_STATUS.ACTIVE);
  assert.throws(() => normalizeRoutineInput({ ...routine, playbook_version: 0 }), /positive integer/);
});

test('native projection carries only a compact HIVE routine envelope', () => {
  const projected = nativeScheduleProjection({
    routine,
    routineId: 'routine-1',
    agentId: 'agentscope-agent-1',
    chatModelConfig: { type: 'cloudflare_gateway_credential', credential_id: 'cred-1', model: 'deepseek/deepseek-v4-flash' },
  });
  assert.equal(projected.enabled, true);
  assert.equal(projected.cron_expression, '0 * * * *');
  assert.deepEqual(JSON.parse(projected.description), {
    kind: 'hive_routine_fire',
    routine_id: 'routine-1',
    playbook_id: 'global:brief',
    playbook_version: 2,
    goal: 'Prepare the operating brief',
  });
});

test('routine fire key and WorkRun scope are deterministic and replay-safe', () => {
  const when = '2026-09-22T10:00:00.000Z';
  const key = routineFireKey('routine-1', when);
  assert.equal(key, 'routine:routine-1:fire:2026-09-22T10:00:00.000Z');
  assert.deepEqual(routineWorkRunScope({ routine, routineId: 'routine-1', fireKey: key, scheduledAt: when }), {
    routine_id: 'routine-1',
    routine_fire_key: key,
    scheduled_at: when,
    playbook_id: 'global:brief',
    playbook_version: 2,
    goal: 'Prepare the operating brief',
    authority_policy: { external_writes: 'approval' },
  });
});

test('routine repository uses parameterized inserts and idempotent fire claims', async () => {
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(...args) {
      calls.push(args);
      if (String(args[0]).includes('INSERT INTO "hivemind"."agentscope_routine_fires"')) {
        return calls.length === 2 ? [{ id: 'fire-1' }] : [];
      }
      return [{ id: 'routine-1', status: 'active' }];
    },
  };
  const created = await createRoutine(prisma, {
    orgId: '00000000-0000-4000-8000-000000000001',
    userId: '00000000-0000-4000-8000-000000000002',
    input: routine,
    agentId: 'agentscope-agent-1',
    chatModelConfig: { model: 'deepseek/deepseek-v4-flash' },
  });
  assert.equal(created.id, 'routine-1');
  assert.equal((await claimRoutineFire(prisma, { routineId: 'routine-1', fireKey: 'fire-key' })).id, 'fire-1');
  assert.equal(await claimRoutineFire(prisma, { routineId: 'routine-1', fireKey: 'fire-key' }), null);
  await setRoutineStatus(prisma, { orgId: 'org-1', routineId: 'routine-1', status: ROUTINE_STATUS.PAUSED });
  assert.equal(calls.length, 4);
});

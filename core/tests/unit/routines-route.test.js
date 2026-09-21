import test from 'node:test';
import assert from 'node:assert/strict';
import { fireRoutine, handleRoutineRoutes } from '../../src/routes/routines.js';

const orgId = '11111111-1111-4111-8111-111111111111';
const userId = '22222222-2222-4222-8222-222222222222';
const routineId = '33333333-3333-4333-8333-333333333333';

function response() {
  return { status: null, body: null, writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
}

function prismaFor(rows) {
  return { async $queryRawUnsafe() { return rows; } };
}

function deps(prisma) {
  return {
    prisma,
    requireSession: async () => ({ session: { orgId, userId } }),
    parseBody: async () => ({}),
    jsonResponse(res, body, status = 200) { res.writeHead(status); res.end(JSON.stringify(body)); return body; },
  };
}

test('routine GET is tenant-scoped and returns the public projection', async () => {
  const row = {
    id: routineId, org_id: orgId, user_id: userId, room_id: '44444444-4444-4444-8444-444444444444',
    agent_id: 'ops-agent', native_schedule_id: 'sched-1', goal: 'daily brief', playbook_id: 'brief',
    playbook_version: 1, schedule_type: 'cron', schedule_expression: '0 9 * * 1-5', timezone: 'UTC',
    status: 'active', authority_policy: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const res = response();
  await handleRoutineRoutes({ ...deps(prismaFor([row])), req: { method: 'GET', headers: {} }, res, url: new URL(`http://x/v1/routines/${routineId}`) });
  assert.equal(res.status, 200);
  assert.equal(res.body.routine.id, routineId);
  assert.equal(res.body.routine.chat_model_config, undefined);
});

test('routine route ignores unrelated paths', async () => {
  const res = response();
  const handled = await handleRoutineRoutes({ ...deps(prismaFor([])), req: { method: 'GET', headers: {} }, res, url: new URL('http://x/v1/other') });
  assert.equal(handled, false);
  assert.equal(res.status, null);
});

test('routine POST rejects an incomplete AgentScope model config before persistence', async () => {
  let persisted = false;
  const res = response();
  const prisma = {
    async $queryRawUnsafe() { persisted = true; return []; },
  };
  await handleRoutineRoutes({
    ...deps(prisma),
    parseBody: async () => ({
      room_id: '44444444-4444-4444-8444-444444444444', agent_id: 'ops-agent',
      playbook_id: 'brief', playbook_version: 1, goal: 'daily brief',
      schedule_type: 'cron', schedule_expression: '0 9 * * 1-5',
      chat_model_config: { model: 'deepseek/deepseek-v4-flash' },
    }),
    req: { method: 'POST', headers: {} },
    res,
    url: new URL('http://x/v1/routines'),
  });
  assert.equal(res.status, 400);
  assert.match(res.body.error, /chat_model_config\.type is required/);
  assert.equal(persisted, false);
});

test('routine POST projects a valid schedule through the injected AgentScope adapter', async () => {
  const body = {
    room_id: '44444444-4444-4444-8444-444444444444', agent_id: 'ops-agent',
    playbook_id: 'brief', playbook_version: 1, goal: 'daily brief',
    schedule_type: 'cron', schedule_expression: '0 9 * * 1-5', timezone: 'UTC',
    chat_model_config: {
      type: 'cloudflare_gateway_credential', credential_id: 'cred-1',
      model: 'deepseek/deepseek-v4-flash', parameters: {},
    },
  };
  const created = {
    id: routineId, org_id: orgId, user_id: userId, room_id: body.room_id,
    agent_id: body.agent_id, native_schedule_id: null, goal: body.goal,
    playbook_id: body.playbook_id, playbook_version: 1, schedule_type: 'cron',
    schedule_expression: body.schedule_expression, timezone: 'UTC', status: 'active',
    authority_policy: {}, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  };
  const calls = [];
  const prisma = {
    async $queryRawUnsafe(...args) {
      calls.push(String(args[0]));
      if (String(args[0]).startsWith('INSERT INTO')) return [created];
      if (String(args[0]).startsWith('UPDATE')) return [{ ...created, native_schedule_id: 'native-1' }];
      return [];
    },
  };
  const res = response();
  let projected;
  await handleRoutineRoutes({
    ...deps(prisma),
    parseBody: async () => body,
    scheduleRuntime: async (method, payload) => { projected = { method, payload }; return { id: 'native-1' }; },
    req: { method: 'POST', headers: {} }, res, url: new URL('http://x/v1/routines'),
  });
  assert.equal(res.status, 201);
  assert.equal(res.body.routine.native_schedule_id, 'native-1');
  assert.equal(projected.method, 'POST');
  assert.equal(projected.payload.chat_model_config.model, body.chat_model_config.model);
  assert.match(projected.payload.description, /hive_routine_fire/);
  assert.equal(calls.length, 2);
});

test('routine fire dispatches once and records history; duplicate fire is a no-op', async () => {
  const routine = {
    id: routineId, org_id: orgId, user_id: userId,
    room_id: '44444444-4444-4444-8444-444444444444', agent_id: 'ops-agent',
    goal: 'daily brief', playbook_id: 'brief', playbook_version: 1,
    schedule_type: 'cron', schedule_expression: '0 9 * * 1-5', authority_policy: {},
    status: 'active', chat_model_config: { type: 'gateway', credential_id: 'cred-1', model: 'm', parameters: {} },
  };
  let claimCount = 0;
  let recorded = null;
  const prisma = {
    async $queryRawUnsafe(sql) {
      if (String(sql).includes('INSERT INTO "hivemind"."agentscope_routine_fires"')) {
        claimCount += 1;
        return claimCount === 1 ? [{ id: 'fire-1' }] : [];
      }
      if (String(sql).includes('UPDATE "hivemind"."agentscope_routine_fires"')) {
        recorded = true;
        return [{ id: 'fire-1', status: 'started' }];
      }
      return [];
    },
  };
  let dispatched = 0;
  const dispatch = async (payload) => {
    dispatched += 1;
    assert.equal(payload.playbookId, 'brief');
    return { workRun: { id: 'workrun-1' }, turnId: 'turn-1' };
  };
  const scheduledAt = '2026-09-22T09:00:00.000Z';
  const first = await fireRoutine({ prisma, routine, routineId, scheduledAt, userId, orgId, dispatch });
  const second = await fireRoutine({ prisma, routine, routineId, scheduledAt, userId, orgId, dispatch });
  assert.equal(first.duplicate, false);
  assert.equal(first.workrun.id, 'workrun-1');
  assert.deepEqual(second, { duplicate: true, fire_key: first.fire_key });
  assert.equal(dispatched, 1);
  assert.equal(recorded, true);
});

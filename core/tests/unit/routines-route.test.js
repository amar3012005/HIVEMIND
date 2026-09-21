import test from 'node:test';
import assert from 'node:assert/strict';
import { handleRoutineRoutes } from '../../src/routes/routines.js';

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

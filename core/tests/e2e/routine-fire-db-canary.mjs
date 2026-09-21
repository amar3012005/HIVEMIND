import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { claimRoutineFire, listRoutineHistory, recordRoutineFire } from '../../src/employees/routine-repository.js';

const prisma = new PrismaClient();
const routineId = randomUUID();
const fireKey = `routine:${routineId}:fire:2026-09-22T09:00:00.000Z`;

try {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."agentscope_routines"
      (id, org_id, user_id, room_id, agent_id, goal, playbook_id, playbook_version,
       schedule_type, schedule_expression, timezone, status, authority_policy,
       chat_model_config, created_by)
     VALUES ($1::uuid, $2::uuid, $2::uuid, $3::uuid, 'canary-agent', 'canary',
       'global:canary', 1, 'cron', '0 9 * * 1-5', 'UTC', 'active', '{}'::jsonb,
       '{"type":"gateway","credential_id":"canary","model":"canary","parameters":{}}'::jsonb,
       $2::uuid)`,
    routineId,
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  );
  const first = await claimRoutineFire(prisma, { routineId, fireKey });
  const duplicate = await claimRoutineFire(prisma, { routineId, fireKey });
  assert.ok(first?.id, 'first fire must claim a durable row');
  assert.equal(duplicate, null, 'duplicate fire must not claim a second row');
  const recorded = await recordRoutineFire(prisma, {
    routineId, fireKey, workRunId: null, status: 'started',
  });
  assert.equal(recorded?.status, 'started');
  const history = await listRoutineHistory(prisma, { routineId, limit: 10 });
  assert.equal(history.length, 1);
  assert.equal(history[0].fire_key, fireKey);
  console.log(`routine-fire-db-canary-ok rows=${history.length}`);
} finally {
  await prisma.$executeRawUnsafe(
    'DELETE FROM "hivemind"."agentscope_routines" WHERE id = $1::uuid',
    routineId,
  ).catch(() => {});
  await prisma.$disconnect();
}

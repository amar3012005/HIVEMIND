import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { failStaleWorkRuns, WORK_RUN_STATUS } from '../../src/employees/work-runs.js';

const prisma = new PrismaClient();
const userId = process.env.HM_USER_ID || 'd1fbfe05-b91a-4cac-9b23-7b96d23c983d';
const orgId = process.env.HM_ORG_ID || '00000000-0000-4000-8000-000000000002';
const roomId = randomUUID();
const workRunId = randomUUID();
const staleAt = new Date(Date.now() - 60 * 60 * 1000);

try {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."hyper_rooms"
       (id, user_id, org_id, name, participant_ids, template, room_tag, room_mode,
        agent_connectors, enabled_connectors, quality_mode, sim_mode, room_journal)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ARRAY[]::uuid[], 'debate', 'general', 'work',
             '{}'::jsonb, ARRAY[]::text[], 'auto', 'off', '[]'::jsonb)`,
    roomId, userId, orgId, 'AgentScope stale recovery canary room',
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."work_runs"
       (id, org_id, user_id, room_id, goal, status, events, result_artifact_ids,
        started_at, heartbeat_at, scope)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, '[]'::jsonb, '[]'::jsonb,
             $7::timestamptz, $7::timestamptz, '{}'::jsonb)`,
    workRunId, orgId, userId, roomId, 'AgentScope stale recovery canary', WORK_RUN_STATUS.RUNNING, staleAt,
  );

  const first = await failStaleWorkRuns(prisma, {
    before: new Date(Date.now() - 5 * 60 * 1000),
    ids: [workRunId],
  });
  assert.deepEqual(first, { attempted: 1, failed: 1, skipped: 0 });
  const rows = await prisma.$queryRawUnsafe(
    `SELECT status, events FROM "hivemind"."work_runs" WHERE id = $1::uuid`, workRunId,
  );
  assert.equal(rows[0].status, WORK_RUN_STATUS.FAILED);
  const failedEvents = (rows[0].events || []).filter((event) => event.t === 'workrun.failed');
  assert.equal(failedEvents.length, 1);

  const replay = await failStaleWorkRuns(prisma, {
    before: new Date(Date.now() - 5 * 60 * 1000),
    ids: [workRunId],
  });
  assert.deepEqual(replay, { attempted: 0, failed: 0, skipped: 0 });
  console.log(`workrun-stale-recovery-db-canary-ok workrun=${workRunId} failed_events=${failedEvents.length}`);
} finally {
  await prisma.$executeRawUnsafe(`DELETE FROM "hivemind"."work_runs" WHERE id = $1::uuid`, workRunId).catch(() => {});
  await prisma.$executeRawUnsafe(`DELETE FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid`, roomId).catch(() => {});
  await prisma.$disconnect();
}

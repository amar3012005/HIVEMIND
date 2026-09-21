import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const base = (process.env.CONTROL_PLANE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiKey = process.env.HM_API_KEY || 'local-master';
const userId = process.env.HM_USER_ID || '00000000-0000-4000-8000-000000000001';
const orgId = process.env.HM_ORG_ID || '00000000-0000-4000-8000-000000000002';
const sessionId = `canary-playbook-${randomUUID()}`;
const workRunId = randomUUID();
const roomId = randomUUID();
const prisma = new PrismaClient();
const headers = {
  'X-API-Key': apiKey,
  'X-HM-User-Id': userId,
  'X-HM-Org-Id': orgId,
  'Content-Type': 'application/json',
};

try {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."hyper_rooms"
       (id, user_id, org_id, name, participant_ids, template, room_tag, room_mode,
        agent_connectors, enabled_connectors, quality_mode, sim_mode, room_journal)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ARRAY[]::uuid[], 'debate', 'general', 'work',
             '{}'::jsonb, ARRAY[]::text[], 'auto', 'off', '[]'::jsonb)`,
    roomId,
    userId,
    orgId,
    'AgentScope company-task canary room',
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."work_runs"
       (id, org_id, user_id, room_id, goal, status, agentscope_session_id, scope)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'queued', $6, '{}'::jsonb)`,
    workRunId,
    orgId,
    userId,
    roomId,
    'AgentScope company-task playbook persistence canary',
    sessionId,
  );

  const response = await fetch(`${base}/internal/hivemind/playbooks/get`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ id: 'global:market-research', agentscope_session_id: sessionId }),
  });
  const body = await response.json();
  assert.equal(response.ok, true, `playbook get returned ${response.status}: ${JSON.stringify(body)}`);
  assert.equal(body.status, 'completed');

  const rows = await prisma.$queryRawUnsafe(
    `SELECT playbook_id, playbook_version, scope
       FROM "hivemind"."work_runs" WHERE id = $1::uuid`,
    workRunId,
  );
  assert.equal(rows.length, 1);
  assert.equal(rows[0].playbook_id, 'global:market-research');
  assert.equal(String(rows[0].playbook_version), String(body.playbook.version));
  assert.deepEqual(rows[0].scope?.completion_contract, {
    tasks: { min_completed: 1, require_all_completed: true },
    artifacts: { min_count: 1 },
  });

  console.log(`company-task-playbook-persistence-canary-ok session=${sessionId}`);
} finally {
  await prisma.$executeRawUnsafe(
    `DELETE FROM "hivemind"."work_runs" WHERE id = $1::uuid`,
    workRunId,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid`,
    roomId,
  );
  await prisma.$disconnect();
}

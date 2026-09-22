import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';

const base = (process.env.CONTROL_PLANE_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const apiKey = process.env.HM_API_KEY || 'local-master';
const userId = process.env.HM_USER_ID || '00000000-0000-4000-8000-000000000001';
const orgId = process.env.HM_ORG_ID || '00000000-0000-4000-8000-000000000002';
const sessionId = `canary-completion-${randomUUID()}`;
const workRunId = randomUUID();
const roomId = randomUUID();
const prisma = new PrismaClient();
const headers = {
  'X-API-Key': apiKey,
  'X-HM-User-Id': userId,
  'X-HM-Org-Id': orgId,
  'Content-Type': 'application/json',
};

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST', headers, body: JSON.stringify(body),
  });
  const payload = await response.json();
  return { response, payload };
}

try {
  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."hyper_rooms"
       (id, user_id, org_id, name, participant_ids, template, room_tag, room_mode,
        agent_connectors, enabled_connectors, quality_mode, sim_mode, room_journal)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ARRAY[]::uuid[], 'debate', 'general', 'work',
             '{}'::jsonb, ARRAY[]::text[], 'auto', 'off', '[]'::jsonb)`,
    roomId, userId, orgId, 'AgentScope completion canary room',
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO "hivemind"."work_runs"
       (id, org_id, user_id, room_id, goal, status, agentscope_session_id, scope)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'running', $6, '{}'::jsonb)`,
    workRunId, orgId, userId, roomId,
    'AgentScope evidence-gated completion canary', sessionId,
  );

  const selected = await post('/internal/hivemind/playbooks/get', {
    id: 'global:market-research', agentscope_session_id: sessionId,
  });
  assert.equal(selected.response.ok, true, JSON.stringify(selected.payload));
  assert.equal(selected.payload.status, 'completed');

  const premature = await post('/internal/hivemind/workruns/complete', {
    agentscope_session_id: sessionId, summary: 'Attempted before evidence existed.',
  });
  assert.equal(premature.response.ok, true, JSON.stringify(premature.payload));
  assert.equal(premature.payload.status, 'incomplete');
  assert.deepEqual(premature.payload.verdict.unmet, [
    { predicate: 'tasks.min_completed', expected: 1, actual: 0 },
    { predicate: 'artifacts.min_count', expected: 1, actual: 0 },
  ]);

  // This is the durable projection emitted by AgentScope's native TaskUpdate
  // middleware, represented here as a persisted plan.updated event.
  await prisma.$executeRawUnsafe(
    `UPDATE "hivemind"."work_runs"
        SET events = $2::jsonb, updated_at = now()
      WHERE id = $1::uuid`,
    workRunId,
    JSON.stringify([{ t: 'plan.updated', tasks: [{ id: 'task-1', state: 'completed' }] }]),
  );

  // Seed the same ordered native AgentScope milestones the runtime forwards.
  // The telemetry endpoint must derive these from the durable WorkRun log,
  // rather than from browser timing marks.  This comes after the compact plan
  // projection above so the canary does not overwrite the event log.
  for (const event of [
    { type: 'REPLY_START', id: 'telemetry-reply' },
    { type: 'THINKING_BLOCK_DELTA', id: 'telemetry-thinking', delta: 'plan' },
    { type: 'TOOL_CALL_START', id: 'telemetry-tool', tool_call_name: 'PlaybookGet' },
    { type: 'TEXT_BLOCK_DELTA', id: 'telemetry-answer', delta: 'ready' },
  ]) {
    const forwarded = await post(`/internal/workruns/${workRunId}/event`, { event });
    assert.equal(forwarded.response.ok, true, JSON.stringify(forwarded.payload));
  }

  const artifact = await post('/internal/hivemind/artifacts', {
    agentscope_session_id: sessionId,
    path: 'workspace/market-brief.md',
    title: 'Sourced market brief',
    content_type: 'text/markdown',
  });
  assert.equal(artifact.response.status, 201, JSON.stringify(artifact.payload));
  assert.equal(artifact.payload.status, 'completed');
  const replayedArtifact = await post('/internal/hivemind/artifacts', {
    agentscope_session_id: sessionId,
    path: 'workspace/market-brief.md',
    title: 'Sourced market brief',
    content_type: 'text/markdown',
  });
  assert.equal(replayedArtifact.response.status, 201, JSON.stringify(replayedArtifact.payload));
  assert.equal(replayedArtifact.payload.artifact_id, artifact.payload.artifact_id);
  const linked = await prisma.$queryRawUnsafe(
    `SELECT result_artifact_ids FROM "hivemind"."work_runs" WHERE id = $1::uuid`, workRunId,
  );
  assert.deepEqual(linked[0].result_artifact_ids, [artifact.payload.artifact_id]);

  const completed = await post('/internal/hivemind/workruns/complete', {
    agentscope_session_id: sessionId,
    summary: 'Produced and verified the sourced market brief.',
  });
  assert.equal(completed.response.ok, true, JSON.stringify(completed.payload));
  assert.equal(completed.payload.status, 'completed');
  assert.equal(completed.payload.workrun_id, workRunId);

  // The browser endpoint is session-authenticated; inspect the same durable
  // row through the control-plane module here so this service canary remains
  // independent of a browser cookie.  The endpoint itself is covered by the
  // route/unit tests and delegates to this exact function.
  const { workRunTelemetry } = await import('/app/src/employees/work-runs.js');
  const telemetryRows = await prisma.$queryRawUnsafe(
    `SELECT events, created_at FROM "hivemind"."work_runs" WHERE id = $1::uuid`,
    workRunId,
  );
  const telemetry = workRunTelemetry(telemetryRows[0].events, {
    submittedAt: new Date(telemetryRows[0].created_at).valueOf(),
  });
  const { marks, elapsed } = telemetry;
  for (const key of ['submit', 'acknowledgement', 'first_thinking', 'first_tool', 'first_answer', 'completion']) {
    assert.equal(Number.isFinite(Number(marks[key])), true, `missing telemetry mark: ${key}`);
    assert.equal(Number.isFinite(Number(elapsed[key])), true, `missing telemetry elapsed: ${key}`);
  }
  assert.ok(marks.submit <= marks.acknowledgement);
  assert.ok(marks.acknowledgement <= marks.first_thinking);
  assert.ok(marks.first_thinking <= marks.first_tool);
  assert.ok(marks.first_tool <= marks.first_answer);
  assert.ok(marks.first_answer <= marks.completion);
  console.log(`workrun-completion-evidence-canary-ok workrun=${workRunId}`);
} finally {
  await prisma.$executeRawUnsafe(
    `DELETE FROM "hivemind"."source_artifacts"
      WHERE source_platform = 'agent-runtime' AND source_id = $1`, workRunId,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "hivemind"."work_runs" WHERE id = $1::uuid`, workRunId,
  );
  await prisma.$executeRawUnsafe(
    `DELETE FROM "hivemind"."hyper_rooms" WHERE id = $1::uuid`, roomId,
  );
  await prisma.$disconnect();
}

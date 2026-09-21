import { normalizeRoutineInput, ROUTINE_STATUS } from './routines.js';

const TABLE = '"hivemind"."agentscope_routines"';

export async function createRoutine(prisma, { orgId, userId, createdBy, input, agentId, employeeId = null, chatModelConfig }) {
  const routine = normalizeRoutineInput(input);
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO ${TABLE}
      (org_id, user_id, room_id, employee_id, agent_id, goal, playbook_id,
       playbook_version, schedule_type, schedule_expression, timezone, status,
       authority_policy, chat_model_config, created_by)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, $9, $10,
             $11, $12, $13::jsonb, $14::jsonb, $2::uuid)
     RETURNING *`,
    orgId,
    userId,
    routine.room_id,
    employeeId,
    agentId,
    routine.goal,
    routine.playbook_id,
    routine.playbook_version,
    routine.schedule_type,
    routine.schedule_expression,
    input.timezone || 'UTC',
    routine.status,
    JSON.stringify(routine.authority_policy),
    JSON.stringify(chatModelConfig || {}),
  );
  return rows?.[0] || null;
}

export async function getRoutine(prisma, { orgId, routineId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM ${TABLE} WHERE id = $1::uuid AND org_id = $2::uuid LIMIT 1`,
    routineId,
    orgId,
  );
  return rows?.[0] || null;
}

export async function getRoutineById(prisma, { routineId }) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT * FROM ${TABLE} WHERE id = $1::uuid LIMIT 1`,
    routineId,
  );
  return rows?.[0] || null;
}

export async function listRoutines(prisma, { orgId, status = null }) {
  if (status) {
    return prisma.$queryRawUnsafe(
      `SELECT * FROM ${TABLE} WHERE org_id = $1::uuid AND status = $2 ORDER BY created_at DESC`,
      orgId,
      status,
    );
  }
  return prisma.$queryRawUnsafe(`SELECT * FROM ${TABLE} WHERE org_id = $1::uuid ORDER BY created_at DESC`, orgId);
}

export async function setRoutineStatus(prisma, { orgId, routineId, status }) {
  if (![ROUTINE_STATUS.ACTIVE, ROUTINE_STATUS.PAUSED, ROUTINE_STATUS.ARCHIVED].includes(status)) {
    throw new TypeError(`unsupported routine status: ${status}`);
  }
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE ${TABLE} SET status = $3, updated_at = now()
     WHERE id = $1::uuid AND org_id = $2::uuid RETURNING *`,
    routineId,
    orgId,
    status,
  );
  return rows?.[0] || null;
}

export async function setNativeScheduleId(prisma, { orgId, routineId, nativeScheduleId }) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE ${TABLE} SET native_schedule_id = $3, updated_at = now()
     WHERE id = $1::uuid AND org_id = $2::uuid RETURNING *`,
    routineId,
    orgId,
    nativeScheduleId,
  );
  return rows?.[0] || null;
}

/** Claim once before dispatching a WorkRun; a duplicate fire is a no-op. */
export async function claimRoutineFire(prisma, { routineId, fireKey }) {
  const rows = await prisma.$queryRawUnsafe(
    `INSERT INTO "hivemind"."agentscope_routine_fires" (routine_id, fire_key)
     VALUES ($1::uuid, $2)
     ON CONFLICT (routine_id, fire_key) DO NOTHING
     RETURNING *`,
    routineId,
    fireKey,
  );
  return rows?.[0] || null;
}

export async function recordRoutineFire(prisma, { routineId, fireKey, workRunId, status = 'started' }) {
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE "hivemind"."agentscope_routine_fires"
     SET work_run_id = $3::uuid, status = $4, updated_at = now()
     WHERE routine_id = $1::uuid AND fire_key = $2 RETURNING *`,
    routineId,
    fireKey,
    workRunId,
    status,
  );
  // Keep the compact Routine projection in sync with its durable fire history.
  // The fire table remains the source of truth; these columns only make the
  // collection/item API cheap to render without a second aggregate query.
  await prisma.$queryRawUnsafe(
    `UPDATE ${TABLE}
     SET last_fire_key = $2, last_run_id = $3::uuid, last_run_at = now(), updated_at = now()
     WHERE id = $1::uuid`,
    routineId,
    fireKey,
    workRunId,
  );
  return rows?.[0] || null;
}

export async function listRoutineHistory(prisma, { routineId, limit = 50 }) {
  return prisma.$queryRawUnsafe(
    `SELECT * FROM "hivemind"."agentscope_routine_fires"
     WHERE routine_id = $1::uuid ORDER BY created_at DESC LIMIT $2::int`,
    routineId,
    Math.min(Math.max(Number(limit) || 50, 1), 200),
  );
}

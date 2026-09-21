import { internalFetch } from '../internal/internal-fetch.js';
import { RUNTIME_URL, dispatchWorkRun } from '../employees/work-runs.js';
import {
  ROUTINE_STATUS,
  canTransitionRoutine,
  nativeScheduleProjection,
  normalizeRoutineInput,
  routineFireKey,
  routineWorkRunScope,
} from '../employees/routines.js';
import {
  claimRoutineFire,
  createRoutine,
  getRoutine,
  getRoutineById,
  listRoutineHistory,
  listRoutines,
  recordRoutineFire,
  setNativeScheduleId,
  setRoutineStatus,
} from '../employees/routine-repository.js';

function runtimeScheduleUrl(id = '') {
  return `${RUNTIME_URL()}/schedule${id ? `/${encodeURIComponent(id)}` : '/'}`;
}

async function runtimeSchedule(method, body, id = '') {
  const response = await internalFetch(runtimeScheduleUrl(id), {
    service: 'hm-agent-runtime', method, body, timeoutMs: 15_000,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload?.detail || payload?.error || `runtime schedule returned ${response.status}`);
  return payload;
}

function publicRoutine(row) {
  if (!row) return null;
  return {
    id: row.id, room_id: row.room_id, employee_id: row.employee_id,
    agent_id: row.agent_id, native_schedule_id: row.native_schedule_id,
    goal: row.goal, playbook_id: row.playbook_id, playbook_version: row.playbook_version,
    schedule_type: row.schedule_type, schedule_expression: row.schedule_expression,
    timezone: row.timezone, status: row.status, authority_policy: row.authority_policy,
    created_at: row.created_at, updated_at: row.updated_at,
    last_fired_at: row.last_fired_at, last_work_run_id: row.last_work_run_id,
  };
}

async function fireRoutine({ prisma, routine, routineId, scheduledAt, userId, orgId, body = {} }) {
  const fireKey = routineFireKey(routineId, scheduledAt);
  const claimed = await claimRoutineFire(prisma, { routineId, fireKey });
  if (!claimed) return { duplicate: true, fire_key: fireKey };
  try {
    const scope = routineWorkRunScope({ routine, routineId, fireKey, scheduledAt });
    const result = await dispatchWorkRun({
      prisma, orgId, userId,
      goal: routine.goal,
      employeeId: routine.employee_id || null,
      roomId: routine.room_id,
      hyperagentSlug: routine.agent_id,
      playbookId: routine.playbook_id,
      playbookVersion: routine.playbook_version,
      scope,
      chatModelConfig: routine.chat_model_config || null,
    });
    await recordRoutineFire({ routineId, fireKey, workRunId: result.workRun.id, status: 'started' });
    return { duplicate: false, fire_key: fireKey, workrun: result.workRun, turn_id: result.turnId };
  } catch (error) {
    await recordRoutineFire({ routineId, fireKey, workRunId: null, status: 'failed' }).catch(() => {});
    throw error;
  }
}

/** Governed Routine API. AgentScope owns the timer; HIVE owns identity/policy/WorkRun. */
export async function handleRoutineRoutes({ req, res, url, prisma, requireSession, parseBody, jsonResponse, internalAuth = false }) {
  const pathname = url.pathname;
  const collection = pathname === '/v1/routines';
  const item = pathname.match(/^\/v1\/routines\/([0-9a-f-]{36})(?:\/(run-now|history))?$/i);
  const internalFire = pathname.match(/^\/internal\/routines\/([0-9a-f-]{36})\/fire$/i);
  if (!collection && !item && !internalFire) return false;

  if (internalFire) {
    if (!internalAuth) return jsonResponse(res, { error: 'Unauthorized' }, 401);
    const routineId = internalFire[1];
    const body = await parseBody(req).catch(() => ({}));
    const routine = body.org_id
      ? await getRoutine(prisma, { orgId: body.org_id, routineId })
      : await getRoutineById(prisma, { routineId });
    if (!routine) return jsonResponse(res, { error: 'Routine not found' }, 404);
    if (routine.status !== ROUTINE_STATUS.ACTIVE) return jsonResponse(res, { skipped: true, status: routine.status });
    try {
      const result = await fireRoutine({
        prisma, routine, routineId,
        scheduledAt: body.scheduled_at || new Date().toISOString(),
        userId: body.user_id || routine.user_id,
        orgId: routine.org_id,
      });
      return jsonResponse(res, result, result.duplicate ? 200 : 202);
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 502);
    }
  }

  const current = await requireSession(req, res);
  if (!current) return true;
  const orgId = current.session.orgId;
  const userId = current.session.userId;

  if (collection && req.method === 'GET') {
    const rows = await listRoutines(prisma, { orgId, status: url.searchParams.get('status') || null });
    return jsonResponse(res, { routines: rows.map(publicRoutine) });
  }
  if (collection && req.method === 'POST') {
    try {
      const body = await parseBody(req);
      const normalized = normalizeRoutineInput(body);
      const agentId = String(body.agent_id || body.agent_runtime_id || '').trim();
      if (!agentId) throw new TypeError('agent_id is required');
      const created = await createRoutine(prisma, {
        orgId, userId, createdBy: userId, input: { ...body, ...normalized },
        agentId, employeeId: body.employee_id || null,
        chatModelConfig: body.chat_model_config || {},
      });
      if (!created) throw new Error('routine insert returned no row');
      try {
        const schedule = await runtimeSchedule('POST', nativeScheduleProjection({
          routine: { ...body, ...normalized, timezone: body.timezone },
          routineId: created.id, agentId, chatModelConfig: body.chat_model_config || {},
        }));
        const nativeId = schedule.id || schedule.schedule_id || schedule.schedule?.id;
        if (!nativeId) throw new Error('runtime schedule response missing id');
        const saved = await setNativeScheduleId(prisma, { orgId, routineId: created.id, nativeScheduleId: nativeId });
        return jsonResponse(res, { routine: publicRoutine(saved || { ...created, native_schedule_id: nativeId }) }, 201);
      } catch (error) {
        await setRoutineStatus(prisma, { orgId, routineId: created.id, status: ROUTINE_STATUS.ARCHIVED }).catch(() => {});
        throw error;
      }
    } catch (error) {
      return jsonResponse(res, { error: error.message }, 400);
    }
  }
  if (!item) return jsonResponse(res, { error: 'Method not allowed' }, 405);
  const routineId = item[1];
  const action = item[2] || null;
  const routine = await getRoutine(prisma, { orgId, routineId });
  if (!routine) return jsonResponse(res, { error: 'Routine not found' }, 404);
  if (action === 'history' && req.method === 'GET') {
    return jsonResponse(res, { history: await listRoutineHistory(prisma, { routineId, limit: url.searchParams.get('limit') }) });
  }
  if (action === 'run-now' && req.method === 'POST') {
    try {
      return jsonResponse(res, await fireRoutine({
        prisma, routine, routineId, scheduledAt: (await parseBody(req).catch(() => ({}))).scheduled_at || new Date().toISOString(), userId, orgId,
      }), 202);
    } catch (error) { return jsonResponse(res, { error: error.message }, 502); }
  }
  if (!action && req.method === 'GET') return jsonResponse(res, { routine: publicRoutine(routine) });
  if (!action && req.method === 'PATCH') {
    try {
      const body = await parseBody(req);
      const status = body.status;
      if (!Object.values(ROUTINE_STATUS).includes(status) || !canTransitionRoutine(routine.status, status)) {
        return jsonResponse(res, { error: `cannot transition routine from ${routine.status} to ${status}` }, 409);
      }
      if (routine.native_schedule_id) await runtimeSchedule('PATCH', { enabled: status === ROUTINE_STATUS.ACTIVE }, routine.native_schedule_id);
      const saved = await setRoutineStatus(prisma, { orgId, routineId, status });
      return jsonResponse(res, { routine: publicRoutine(saved) });
    } catch (error) { return jsonResponse(res, { error: error.message }, 400); }
  }
  return jsonResponse(res, { error: 'Method not allowed' }, 405);
}

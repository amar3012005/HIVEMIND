/**
 * AgentScope WorkRun control-plane projection.
 *
 * This module deliberately does not plan or execute work. AgentScope owns the
 * session and native Task state; HIVE owns the durable run envelope, tenancy,
 * lifecycle, and the stable event vocabulary consumed by Rooms.
 */

export const WORK_RUN_STATUS = Object.freeze({
  QUEUED: 'queued', STARTING: 'starting', RUNNING: 'running',
  COMPLETED: 'completed', FAILED: 'failed', CANCELLED: 'cancelled',
});

const TERMINAL = new Set([
  WORK_RUN_STATUS.COMPLETED, WORK_RUN_STATUS.FAILED, WORK_RUN_STATUS.CANCELLED,
]);
const TRANSITIONS = Object.freeze({
  queued: new Set(['starting', 'cancelled', 'failed']),
  starting: new Set(['running', 'cancelled', 'failed']),
  running: new Set(['completed', 'cancelled', 'failed']),
  completed: new Set(), failed: new Set(), cancelled: new Set(),
});
const MAX_EVENTS = 500;

export function isTerminalWorkRun(status) {
  return TERMINAL.has(String(status || ''));
}

export function canTransitionWorkRun(from, to) {
  return from === to || Boolean(TRANSITIONS[from]?.has(to));
}

function preview(value) {
  if (value == null) return null;
  try { return (typeof value === 'string' ? value : JSON.stringify(value)).slice(0, 12_000); }
  catch { return String(value).slice(0, 12_000); }
}

function nativeTask(name) {
  return /^Task(Create|Update|List|Get)$/i.test(String(name || ''));
}

/** Turn AgentScope events into a product vocabulary at one boundary. */
export function normalizeAgentScopeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || event.t || '').toUpperCase();
  const ts = Date.now();
  const tool = event.tool_call_name || event.tool_name || event.name || null;
  const callId = event.tool_call_id || event.id || null;

  if (type === 'REPLY_START') return { t: 'agent.status', status: 'thinking', ts };
  if (type === 'REPLY_END') {
    const reason = event.finished_reason || event.reason || 'completed';
    return reason === 'completed'
      ? { t: 'agent.status', status: 'idle', reason, ts }
      : { t: 'workrun.failed', reason, error: 'The agent stopped before finishing. Work is saved.', ts };
  }
  if (type === 'TOOL_CALL_START') {
    return nativeTask(tool)
      ? { t: 'plan.updated', family: 'task', tool, call_id: callId, ts }
      : { t: 'tool.started', tool, call_id: callId, ts };
  }
  if (type === 'TOOL_RESULT_END') {
    return nativeTask(tool)
      ? { t: 'plan.updated', family: 'task', tool, call_id: callId, ts }
      : { t: 'tool.completed', tool, call_id: callId, state: event.state || 'success', result: preview(event.output ?? event.result ?? event.content), ts };
  }
  if (type === 'CUSTOM' && event.name === 'state_updated') {
    const tasks = event.value?.tasks_context?.tasks;
    if (!Array.isArray(tasks)) return null;
    return {
      t: 'plan.updated', family: 'task',
      tasks: tasks.map((task) => ({
        id: task?.id || null, subject: task?.subject || '', description: task?.description || '',
        state: task?.state || null, blocked_by: Array.isArray(task?.blocked_by) ? task.blocked_by : [],
        owner: task?.owner || null,
      })), ts,
    };
  }
  if (type === 'CUSTOM' && event.name === 'artifact.created') {
    return { t: 'artifact.created', artifact_id: event.value?.artifact_id || null, path: event.value?.path || null, ts };
  }
  return null;
}

export async function appendWorkRunEvent(prisma, workRunId, event) {
  if (!event) return null;
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE "hivemind"."work_runs"
       SET events = CASE
             WHEN jsonb_array_length(COALESCE(events, '[]'::jsonb)) >= $2::int
               THEN (COALESCE(events, '[]'::jsonb) -> -($2::int - 1)) || jsonb_set($3::jsonb, '{0,seq}', to_jsonb(jsonb_array_length(COALESCE(events, '[]'::jsonb)) + 1))
             ELSE COALESCE(events, '[]'::jsonb) || jsonb_set($3::jsonb, '{0,seq}', to_jsonb(jsonb_array_length(COALESCE(events, '[]'::jsonb)) + 1))
           END,
           heartbeat_at = now(), updated_at = now()
     WHERE id = $1::uuid RETURNING id, status`,
    workRunId, MAX_EVENTS, JSON.stringify([event]),
  );
  return rows?.[0] || null;
}

export async function transitionWorkRun(prisma, workRunId, to, patch = {}) {
  const rows = await prisma.$queryRawUnsafe(
    'SELECT id, status FROM "hivemind"."work_runs" WHERE id = $1::uuid', workRunId,
  );
  const current = rows?.[0];
  if (!current) return { ok: false, reason: 'not_found' };
  if (!canTransitionWorkRun(current.status, to)) {
    return { ok: false, reason: 'illegal_transition', from: current.status, to };
  }
  const sets = ['status = $2', 'updated_at = now()'];
  const params = [workRunId, to];
  const add = (column, value, cast = '') => { params.push(value); sets.push(`${column} = $${params.length}${cast}`); };
  if (patch.error !== undefined) add('error', patch.error);
  if (patch.result !== undefined) add('result', JSON.stringify(patch.result), '::jsonb');
  if (patch.agentscopeSessionId !== undefined) add('agentscope_session_id', patch.agentscopeSessionId);
  if (patch.workspaceId !== undefined) add('workspace_id', patch.workspaceId);
  if (to === 'running') sets.push('started_at = COALESCE(started_at, now())');
  if (isTerminalWorkRun(to)) sets.push('completed_at = now()');
  const updated = await prisma.$queryRawUnsafe(
    `UPDATE "hivemind"."work_runs" SET ${sets.join(', ')} WHERE id = $1::uuid RETURNING *`, ...params,
  );
  return { ok: true, run: updated?.[0] || null };
}

/** Apply one runtime event. Completion is explicit and handled by the caller. */
export async function applyRuntimeEvent(prisma, workRunId, rawEvent) {
  const event = normalizeAgentScopeEvent(rawEvent);
  if (!event) return { applied: false, reason: 'not_ui_relevant' };
  const rows = await prisma.$queryRawUnsafe(
    'SELECT id, status, events FROM "hivemind"."work_runs" WHERE id = $1::uuid', workRunId,
  );
  const run = rows?.[0];
  if (!run) return { applied: false, reason: 'not_found' };
  if (isTerminalWorkRun(run.status)) return { applied: false, reason: 'terminal' };
  if (event.t === 'tool.completed' && !event.tool && event.call_id && Array.isArray(run.events)) {
    event.tool = [...run.events].reverse().find(
      (prior) => prior?.t === 'tool.started' && prior.call_id === event.call_id,
    )?.tool || null;
  }
  await appendWorkRunEvent(prisma, workRunId, event);
  if (event.t === 'workrun.failed') {
    await transitionWorkRun(prisma, workRunId, 'failed', { error: event.error });
  }
  return { applied: true, event };
}

export async function completeWorkRun(prisma, workRunId, { result = {}, error = null } = {}) {
  const to = error ? 'failed' : 'completed';
  const outcome = await transitionWorkRun(prisma, workRunId, to, { result, ...(error ? { error } : {}) });
  if (outcome.ok) await appendWorkRunEvent(prisma, workRunId, {
    t: error ? 'workrun.failed' : 'workrun.completed', ...(error ? { error } : { result }), ts: Date.now(),
  });
  return outcome;
}

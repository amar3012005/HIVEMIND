import { internalFetch } from '../internal/internal-fetch.js';

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
// L0 is intentionally a compact routing envelope. Company facts, complete
// playbooks, and prior artifacts must arrive through the progressively exposed
// HIVE tools, never as caller-controlled prompt baggage at WorkRun creation.
const MAX_INITIAL_SCOPE_BYTES = 12_000;
const RESERVED_SCOPE_KEYS = new Set(['completion_contract', 'runtime_binding', 'local_playbooks']);
const EXECUTION_MODES = new Set(['direct', 'company_answer', 'operating_plan']);

function scopeError(message) {
  return Object.assign(new Error(message), { code: 'WORKRUN_SCOPE_INVALID' });
}

export function normalizeInitialWorkRunScope(scope) {
  if (!scope || typeof scope !== 'object' || Array.isArray(scope)) {
    if (scope == null) return {};
    throw scopeError('WorkRun scope must be an object containing compact references.');
  }
  const candidate = Object.fromEntries(
    Object.entries(scope).filter(([key]) => !RESERVED_SCOPE_KEYS.has(key)),
  );
  if (candidate.execution_mode != null && !EXECUTION_MODES.has(candidate.execution_mode)) {
    throw scopeError('WorkRun execution_mode must be direct, company_answer, or operating_plan.');
  }
  let serialized;
  try { serialized = JSON.stringify(candidate); }
  catch { throw scopeError('WorkRun scope must be JSON-serializable.'); }
  if (!serialized) throw scopeError('WorkRun scope must be JSON-serializable.');
  if (Buffer.byteLength(serialized, 'utf8') > MAX_INITIAL_SCOPE_BYTES) {
    throw scopeError(`WorkRun scope exceeds the ${MAX_INITIAL_SCOPE_BYTES}-byte L0 context budget; pass record references and load details progressively.`);
  }
  return JSON.parse(serialized);
}

// Task state is a native AgentScope capability, but presenting it as an
// operating plan is a product decision owned by the durable Core envelope.
// The safe default is direct: callers must explicitly select an operating plan
// rather than a casual turn accidentally acquiring one.
export function isOperatingPlanScope(scope) {
  return asObject(scope).execution_mode === 'operating_plan';
}

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

function asObject(value, fallback = {}) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  try { return Array.isArray(JSON.parse(String(value || ''))) ? JSON.parse(String(value || '')) : []; } catch { return []; }
}

/**
 * Validate data selected by HIVE, never execute it. AgentScope's Task state is
 * the source of truth; this merely refuses a terminal receipt that contradicts
 * the last native task snapshot or an evidence minimum declared by the chosen
 * playbook.
 */
export function validateWorkRunCompletion(run) {
  const scope = asObject(run?.scope);
  const contract = asObject(scope.completion_contract);
  const unmet = [];
  const plan = [...asArray(run?.events)].reverse().find((event) => event?.t === 'plan.updated' && Array.isArray(event.tasks));
  const tasks = Array.isArray(plan?.tasks) ? plan.tasks : [];
  if (contract.requires_task_plan && !tasks.length) unmet.push({ predicate: 'has_native_task_plan', message: 'The selected playbook requires an AgentScope Task plan.' });
  const open = tasks.filter((task) => task?.state !== 'completed');
  if (open.length) unmet.push({ predicate: 'all_native_tasks_completed', task_ids: open.map((task) => task?.id).filter(Boolean), message: 'Native AgentScope tasks are still open.' });
  const artifactCount = asArray(run?.result_artifact_ids).length;
  const minArtifacts = Math.max(0, Number(contract.min_artifacts) || 0);
  if (artifactCount < minArtifacts) unmet.push({ predicate: 'has_min_artifacts', expected: minArtifacts, actual: artifactCount, message: 'The selected playbook requires more registered artifact evidence.' });
  return { ok: unmet.length === 0, unmet, task_count: tasks.length, artifact_count: artifactCount };
}

/** Turn AgentScope events into a product vocabulary at one boundary. */
export function normalizeAgentScopeEvent(event, { executionMode = 'direct' } = {}) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || event.t || '').toUpperCase();
  const ts = Date.now();
  const tool = event.tool_call_name || event.tool_name || event.name || null;
  const callId = event.tool_call_id || event.id || null;
  // AgentScope assigns an id to each event it puts on its replayable session
  // stream. Preserve that identity at the Core boundary: reconnecting a
  // forwarder must update neither the ordered WorkRun log nor a Rooms block a
  // second time. A tool-call id is deliberately not a substitute here because
  // one tool call has several distinct start/delta/result events.
  const sourceEventId = typeof event.id === 'string' && event.id ? event.id : null;
  const emit = (value) => (sourceEventId ? { ...value, source_event_id: sourceEventId } : value);
  // The browser must be able to reconstruct a live assistant turn from the
  // durable WorkRun stream alone.  Keep the native event discriminator and
  // fields required by the transcript reducer alongside HIVE's compact
  // product projection.  A subscriber that joins after AgentScope emitted a
  // delta then receives the same ordered block, rather than waiting for a
  // page refresh to fetch the final session history.
  const native = (value) => emit({ ...value, type });

  if (type === 'REPLY_START') return native({
    t: 'agent.status', status: 'thinking', reply_id: event.reply_id || event.id || null, ts,
  });
  if (type === 'REPLY_END') {
    const reason = event.finished_reason || event.reason || 'completed';
    return reason === 'completed'
      ? native({ t: 'agent.status', status: 'idle', reason, finished_reason: reason, ts })
      : native({ t: 'workrun.failed', reason, finished_reason: reason, error: 'The agent stopped before finishing. Work is saved.', ts });
  }
  // AgentScope reports the selected model separately at MODEL_CALL_START and
  // the authoritative accounting at MODEL_CALL_END. Keep both as ordered
  // turn metadata so Rooms can show what the provider actually reported
  // without guessing usage or cache values.
  if (type === 'MODEL_CALL_START') return native({
    t: 'turn.usage',
    reply_id: event.reply_id || null,
    usage: { model_name: event.model_name || event.model || null },
    ts,
  });
  if (type === 'MODEL_CALL_END') return native({
    t: 'turn.usage',
    reply_id: event.reply_id || null,
    usage: {
      input_tokens: event.input_tokens,
      output_tokens: event.output_tokens,
      cache_input_tokens: event.cache_input_tokens,
      cache_creation_input_tokens: event.cache_creation_input_tokens,
    },
    ts,
  });
  if (type === 'TEXT_BLOCK_DELTA' || type === 'TEXT_BLOCK_END'
    || type === 'THINKING_BLOCK_DELTA' || type === 'THINKING_BLOCK_END') {
    return native({
      t: 'assistant.delta',
      delta: String(event.delta ?? event.text ?? event.content ?? event.output ?? event.thinking ?? ''),
      block_id: event.block_id || null,
      reply_id: event.reply_id || null,
      ts,
    });
  }
  if (type === 'TOOL_CALL_START') {
    return nativeTask(tool) && executionMode === 'operating_plan'
      ? native({ t: 'plan.updated', family: 'task', execution_mode: executionMode, tool, tool_call_name: tool, tool_call_id: callId, call_id: callId, input: event.input ?? event.arguments ?? event.args, ts })
      : native({ t: 'tool.started', tool, tool_call_name: tool, tool_call_id: callId, call_id: callId, input: event.input ?? event.arguments ?? event.args, ts });
  }
  // AgentScope carries tool arguments incrementally. Retain the chunks in
  // HIVE's durable event log so a reconnecting Rooms client can show the same
  // inspectable call input as the live session stream.
  if (type === 'TOOL_CALL_DELTA') {
    return native({ t: 'tool.input.delta', tool_call_name: tool, tool_call_id: callId, call_id: callId, delta: String(event.delta || '').slice(0, 12_000), ts });
  }
  if (type === 'TOOL_RESULT_TEXT_DELTA') {
    return native({ t: 'tool.output.delta', tool_call_name: tool, tool_call_id: callId, call_id: callId, delta: String(event.delta || '').slice(0, 12_000), ts });
  }
  if (type === 'TOOL_RESULT_END') {
    const team = asObject(event.metadata?.hivemind_team, null);
    if (team?.team_id && team?.action) {
      return native({
        t: 'team.updated',
        team_id: team.team_id,
        action: team.action,
        team_name: team.team_name || null,
        leader_session_id: team.leader_session_id || null,
        member: team.member || null,
        member_agent_id: team.member_agent_id || null,
        member_session_id: team.member_session_id || null,
        member_origin: team.member_origin || null,
        recipient: team.recipient || null,
        ts,
      });
    }
    return nativeTask(tool) && executionMode === 'operating_plan'
      ? native({ t: 'plan.updated', family: 'task', execution_mode: executionMode, tool, tool_call_name: tool, tool_call_id: callId, call_id: callId, ts })
      : native({ t: 'tool.completed', tool, tool_call_name: tool, tool_call_id: callId, call_id: callId, state: event.state || 'success', result: preview(event.output ?? event.result ?? event.content), output: event.output ?? event.result ?? event.content, metadata: event.metadata || {}, ts });
  }
  if (type === 'CUSTOM' && event.name === 'state_updated') {
    if (executionMode !== 'operating_plan') return null;
    const tasks = event.value?.tasks_context?.tasks;
    if (!Array.isArray(tasks)) return null;
    return emit({
      t: 'plan.updated', family: 'task', execution_mode: executionMode,
      tasks: tasks.map((task) => ({
        id: task?.id || null, subject: task?.subject || '', description: task?.description || '',
        state: task?.state || null, blocked_by: Array.isArray(task?.blocked_by) ? task.blocked_by : [],
        owner: task?.owner || null,
      })), ts,
    });
  }
  if (type === 'CUSTOM' && event.name === 'artifact.created') {
    return emit({ t: 'artifact.created', artifact_id: event.value?.artifact_id || null, path: event.value?.path || null, ts });
  }
  return null;
}

export async function appendWorkRunEvent(prisma, workRunId, event) {
  if (!event) return null;
  const sourceEventId = typeof event.source_event_id === 'string' && event.source_event_id ? event.source_event_id : null;
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE "hivemind"."work_runs"
       SET events = CASE
             WHEN jsonb_array_length(COALESCE(events, '[]'::jsonb)) >= $2::int
               THEN (COALESCE(events, '[]'::jsonb) -> -($2::int - 1)) || jsonb_set($3::jsonb, '{0,seq}', to_jsonb(jsonb_array_length(COALESCE(events, '[]'::jsonb)) + 1))
             ELSE COALESCE(events, '[]'::jsonb) || jsonb_set($3::jsonb, '{0,seq}', to_jsonb(jsonb_array_length(COALESCE(events, '[]'::jsonb)) + 1))
           END,
           heartbeat_at = now(), updated_at = now()
     WHERE id = $1::uuid
       AND ($4::text IS NULL OR NOT EXISTS (
         SELECT 1
           FROM jsonb_array_elements(COALESCE(events, '[]'::jsonb)) AS prior(event)
          WHERE prior.event ->> 'source_event_id' = $4::text
       ))
     RETURNING id, status`,
    workRunId, MAX_EVENTS, JSON.stringify([event]), sourceEventId,
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
  const rows = await prisma.$queryRawUnsafe(
    'SELECT id, status, events, scope FROM "hivemind"."work_runs" WHERE id = $1::uuid', workRunId,
  );
  const run = rows?.[0];
  if (!run) return { applied: false, reason: 'not_found' };
  if (isTerminalWorkRun(run.status)) return { applied: false, reason: 'terminal' };
  const event = normalizeAgentScopeEvent(rawEvent, {
    executionMode: isOperatingPlanScope(run.scope) ? 'operating_plan' : 'direct',
  });
  if (!event) return { applied: false, reason: 'not_ui_relevant' };
  if (event.t === 'tool.completed' && !event.tool && event.call_id && Array.isArray(run.events)) {
    event.tool = [...run.events].reverse().find(
      (prior) => prior?.t === 'tool.started' && prior.call_id === event.call_id,
    )?.tool || null;
  }
  const appended = await appendWorkRunEvent(prisma, workRunId, event);
  if (!appended) return { applied: false, reason: 'duplicate', event };
  if (event.t === 'workrun.failed') {
    await transitionWorkRun(prisma, workRunId, 'failed', { error: event.error });
  }
  return { applied: true, event };
}

export async function completeWorkRun(prisma, workRunId, { result = {}, error = null, validate = false } = {}) {
  if (validate && !error) {
    const rows = await prisma.$queryRawUnsafe(
      'SELECT scope, events, result_artifact_ids FROM "hivemind"."work_runs" WHERE id = $1::uuid', workRunId,
    );
    const verdict = validateWorkRunCompletion(rows?.[0]);
    if (!verdict.ok) return { ok: false, reason: 'completion_contract_unmet', ...verdict };
  }
  const to = error ? 'failed' : 'completed';
  const outcome = await transitionWorkRun(prisma, workRunId, to, { result, ...(error ? { error } : {}) });
  if (outcome.ok) await appendWorkRunEvent(prisma, workRunId, {
    t: error ? 'workrun.failed' : 'workrun.completed', ...(error ? { error } : { result }), ts: Date.now(),
  });
  return outcome;
}

/**
 * Cancel a WorkRun once the runtime has acknowledged cancellation.  The
 * terminal event is deliberately durable as well as a stream state: a Rooms
 * client that reconnects after the SSE closes must not infer that the current
 * reply is still live from an older progress log.
 */
export async function cancelWorkRun(prisma, workRunId) {
  const outcome = await transitionWorkRun(prisma, workRunId, 'cancelled');
  if (outcome.ok) {
    await appendWorkRunEvent(prisma, workRunId, {
      t: 'workrun.cancelled',
      reason: 'cancelled_by_user',
      ts: Date.now(),
    });
  }
  return outcome;
}

export const agentScopeRuntimeUrl = () =>
  String(process.env.HM_AGENT_RUNTIME_URL || 'http://hm-agent-runtime-v2:8000').replace(/\/+$/, '');

function expectedAgentScopeRuntimeBuildRef() {
  return String(process.env.HM_AGENT_RUNTIME_BUILD_REF || '').trim();
}

/**
 * Opt-in source-parity guard. A WorkRun must never be silently dispatched to
 * a different AgentScope image than the release selected. Existing deployments
 * remain compatible until they set HM_AGENT_RUNTIME_BUILD_REF to an immutable
 * source revision that their runtime image was built with.
 */
export async function verifyAgentScopeRuntimeBuild({ runtimeFetch = internalFetch, userId, orgId } = {}) {
  const expected = expectedAgentScopeRuntimeBuildRef();
  if (!expected) return null;
  const response = await runtimeFetch(`${agentScopeRuntimeUrl()}/runtime/identity`, {
    service: 'hm-agent-runtime', method: 'GET', userId, orgId, timeoutMs: 5_000,
  });
  const identity = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(identity.detail || identity.error || `AgentScope identity returned ${response.status}`);
  if (identity.build_ref !== expected) {
    throw new Error(`AgentScope runtime build mismatch: expected ${expected}, got ${identity.build_ref || 'unknown'}`);
  }
  return identity;
}

/** Reattach Core's event forwarder to an existing AgentScope session.
 *
 * Recovery is intentionally unable to dispatch a goal. The runtime verifies
 * the durable session/agent/workspace tuple and only resumes its subscriber.
 */
export async function recoverWorkRun({ prisma, workRunId, userId, orgId, runtimeFetch = internalFetch } = {}) {
  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status, agentscope_session_id, workspace_id, turn_id, room_id, scope
       FROM "hivemind"."work_runs"
      WHERE id = $1::uuid AND user_id = $2::uuid AND org_id = $3::uuid LIMIT 1`,
    workRunId, userId, orgId,
  );
  const run = rows?.[0];
  if (!run) return { ok: false, reason: 'not_found' };
  if (isTerminalWorkRun(run.status)) return { ok: false, reason: 'terminal' };
  const binding = asObject(run.scope).runtime_binding;
  const agentId = String(binding?.agent_id || '').trim();
  if (!run.agentscope_session_id || !agentId || !run.turn_id || !run.room_id) {
    return { ok: false, reason: 'recovery_binding_missing' };
  }
  await verifyAgentScopeRuntimeBuild({ runtimeFetch, userId, orgId });
  const response = await runtimeFetch(`${agentScopeRuntimeUrl()}/workrun/recover`, {
    service: 'hm-agent-runtime', method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: {
      workrun_id: run.id, agent_id: agentId, session_id: run.agentscope_session_id,
      turn_id: run.turn_id, room_id: run.room_id, org_id: orgId,
      ...(run.workspace_id ? { workspace_id: run.workspace_id } : {}),
    }, userId, orgId, timeoutMs: 20_000,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.detail || payload.error || `AgentScope recovery returned ${response.status}`);
  await appendWorkRunEvent(prisma, run.id, { t: 'workrun.recovered', session_id: run.agentscope_session_id, ts: Date.now() });
  return { ok: true, run, recovery: payload };
}

/**
 * Create HIVE's durable envelope, then hand precisely that envelope to the
 * AgentScope service. The service receives no database credentials and never
 * decides tenancy, room ownership, or policy.
 */
export async function dispatchWorkRun({
  prisma, orgId, userId, goal, roomId = null, playbookId = null,
  playbookVersion = null, scope = {}, chatModelConfig = null,
  runtimeFetch = internalFetch,
} = {}) {
  if (!orgId || !userId || !String(goal || '').trim()) throw new Error('orgId, userId, and goal are required');
  const initialScope = normalizeInitialWorkRunScope(scope);
  await verifyAgentScopeRuntimeBuild({ runtimeFetch, userId, orgId });
  let resolvedRoomId = roomId;
  if (!resolvedRoomId) {
    const rows = await prisma.$queryRawUnsafe(
      `SELECT id FROM "hivemind"."hyper_rooms"
       WHERE org_id = $1::uuid AND archived_at IS NULL
       ORDER BY CASE WHEN agent_connectors ? '_company' THEN 0 ELSE 1 END, created_at DESC LIMIT 1`,
      orgId,
    );
    resolvedRoomId = rows?.[0]?.id || null;
  }
  if (!resolvedRoomId) throw new Error('No active room is available for this WorkRun. Create or restore a room first.');

  const turn = await prisma.$transaction(async (tx) => {
    const last = await tx.hyperTurn.findFirst({ where: { roomId: resolvedRoomId }, orderBy: { seq: 'desc' }, select: { seq: true } });
    const seq = (last?.seq ?? 0) + 1;
    return tx.hyperTurn.create({ data: {
      roomId: resolvedRoomId, seq, userMessage: String(goal).slice(0, 8000), status: 'live',
      idempotencyKey: `workrun:${resolvedRoomId}:${seq}:${Date.now()}`.slice(0, 64),
      lines: [{ t: 'turn_ack', agent: 'director', content: 'Request received. Preparing the right context and capabilities.', immediate: true, ts: Date.now() }],
    } });
  });
  const inserted = await prisma.$queryRawUnsafe(
    `INSERT INTO "hivemind"."work_runs" (org_id, user_id, room_id, turn_id, goal, status, playbook_id, playbook_version, scope)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'queued', $6, $7, $8::jsonb) RETURNING *`,
    orgId, userId, resolvedRoomId, turn.id, String(goal), playbookId, playbookVersion, JSON.stringify(initialScope),
  );
  const workRun = inserted?.[0];
  if (!workRun) throw new Error('WorkRun creation did not return a record');
  await appendWorkRunEvent(prisma, workRun.id, { t: 'workrun.started', goal: String(goal).slice(0, 500), playbook: playbookId, ts: Date.now() });
  await transitionWorkRun(prisma, workRun.id, 'starting');
  try {
    const response = await runtimeFetch(`${agentScopeRuntimeUrl()}/workrun/`, {
      service: 'hm-agent-runtime', method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: {
        workrun_id: workRun.id, agent_id: 'workrun-default', turn_id: turn.id, room_id: resolvedRoomId,
        org_id: orgId, goal: String(goal), playbook_id: playbookId, playbook_version: playbookVersion,
        scope: initialScope, ...(chatModelConfig ? { chat_model_config: chatModelConfig } : {}),
      }, userId, orgId, timeoutMs: 30_000,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.detail || payload.error || `AgentScope runtime returned ${response.status}`);
    if (payload.agent_id) await prisma.$queryRawUnsafe(
      `UPDATE "hivemind"."work_runs"
          SET scope = COALESCE(scope, '{}'::jsonb) || jsonb_build_object('runtime_binding', jsonb_build_object('agent_id', $2::text)),
              updated_at = now()
        WHERE id = $1::uuid`,
      workRun.id, String(payload.agent_id),
    );
    const started = await transitionWorkRun(prisma, workRun.id, 'running', {
      agentscopeSessionId: payload.session_id || null, workspaceId: payload.workspace_id || null,
    });
    return { workRun: started.run || workRun, turnId: turn.id, sessionId: payload.session_id || null };
  } catch (error) {
    await transitionWorkRun(prisma, workRun.id, 'failed', { error: `runtime dispatch failed: ${error.message}` });
    await appendWorkRunEvent(prisma, workRun.id, { t: 'workrun.failed', error: 'The agent runtime could not start. Work is saved.', ts: Date.now() });
    throw error;
  }
}

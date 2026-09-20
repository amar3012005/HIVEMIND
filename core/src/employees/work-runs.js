/**
 * WorkRun — the durable unit of work hm-core hands down to the agent runtime.
 *
 * This module is the hm-core half of the seam. It owns:
 *
 *   1. **Lifecycle.** `queued → starting → running → waiting_approval|paused →
 *      completed|failed|cancelled`. Transitions are validated, not free-form —
 *      a run cannot go from `completed` back to `running`, and a terminal run
 *      cannot be re-dispatched.
 *
 *   2. **The event vocabulary.** The runtime emits AgentScope-native events
 *      (`REPLY_START`, `TOOL_CALL_START`, …). The UI must not learn that
 *      vocabulary, and the runtime must not learn the UI's. This module is the
 *      single translation point: AgentScope event → one of a small, stable set
 *      of `workrun.*` events that the UI renders.
 *
 *   3. **Dispatch.** Resolving the employee + playbook + scope, creating the
 *      HyperTurn the runtime's identity contract requires, and calling the
 *      runtime's `POST /workrun/`.
 *
 * Boundary rule (do not cross it): hm-core owns identity/org/policy/WorkRun;
 * the runtime owns sessions/workspaces/teams. Nothing here knows what an
 * AgentScope session *is* — only its id. Nothing in the runtime knows what a
 * WorkRun *is* — only its id.
 */

import { internalFetch } from '../internal/internal-fetch.js';

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

/** The only states a WorkRun may hold. */
export const WORK_RUN_STATUS = Object.freeze({
  QUEUED: 'queued',
  STARTING: 'starting',
  RUNNING: 'running',
  WAITING_APPROVAL: 'waiting_approval',
  PAUSED: 'paused',
  COMPLETED: 'completed',
  FAILED: 'failed',
  CANCELLED: 'cancelled',
});

/** States from which no further transition is possible. */
export const TERMINAL_STATUSES = Object.freeze([
  WORK_RUN_STATUS.COMPLETED,
  WORK_RUN_STATUS.FAILED,
  WORK_RUN_STATUS.CANCELLED,
]);

/**
 * Allowed transitions. A transition not listed here is rejected rather than
 * silently applied — an illegal state change is a bug in the caller, and
 * swallowing it would leave the UI rendering a state the run never reached.
 */
const TRANSITIONS = Object.freeze({
  [WORK_RUN_STATUS.QUEUED]: [
    WORK_RUN_STATUS.STARTING,
    WORK_RUN_STATUS.CANCELLED,
    WORK_RUN_STATUS.FAILED,
  ],
  [WORK_RUN_STATUS.STARTING]: [
    WORK_RUN_STATUS.RUNNING,
    WORK_RUN_STATUS.FAILED,
    WORK_RUN_STATUS.CANCELLED,
  ],
  [WORK_RUN_STATUS.RUNNING]: [
    WORK_RUN_STATUS.WAITING_APPROVAL,
    WORK_RUN_STATUS.PAUSED,
    WORK_RUN_STATUS.COMPLETED,
    WORK_RUN_STATUS.FAILED,
    WORK_RUN_STATUS.CANCELLED,
  ],
  [WORK_RUN_STATUS.WAITING_APPROVAL]: [
    WORK_RUN_STATUS.RUNNING,
    WORK_RUN_STATUS.FAILED,
    WORK_RUN_STATUS.CANCELLED,
  ],
  [WORK_RUN_STATUS.PAUSED]: [
    WORK_RUN_STATUS.RUNNING,
    WORK_RUN_STATUS.FAILED,
    WORK_RUN_STATUS.CANCELLED,
  ],
  [WORK_RUN_STATUS.COMPLETED]: [],
  [WORK_RUN_STATUS.FAILED]: [],
  [WORK_RUN_STATUS.CANCELLED]: [],
});

export function isTerminal(status) {
  return TERMINAL_STATUSES.includes(status);
}

export function canTransition(from, to) {
  if (from === to) return true; // idempotent re-assert
  return (TRANSITIONS[from] || []).includes(to);
}

// ---------------------------------------------------------------------------
// Event vocabulary — the single translation point
// ---------------------------------------------------------------------------

/**
 * The normalized event vocabulary the UI renders. Deliberately small: the UI
 * should never need to know an AgentScope event name, and adding a UI feature
 * should not require the runtime to emit a new event shape.
 */
export const WORK_RUN_EVENT = Object.freeze({
  STARTED: 'workrun.started',
  STATUS: 'agent.status',
  TOOL_STARTED: 'tool.started',
  TOOL_COMPLETED: 'tool.completed',
  WORKSPACE_STARTED: 'workspace.started',
  ARTIFACT_CREATED: 'artifact.created',
  APPROVAL_REQUESTED: 'approval.requested',
  TEAM_MEMBER_STARTED: 'team.member.started',
  PLAN: 'plan.updated',
  COMPLETED: 'workrun.completed',
  FAILED: 'workrun.failed',
});

function isNativeTaskTool(name) {
  return /^Task(Create|Update|List|Get)$/i.test(String(name || ''));
}

/** User-visible failure. Never persist a Gateway/OpenAI payload. */
export function publicWorkRunError(err) {
  const raw = typeof err === 'string'
    ? err
    : (err && typeof err === 'object' && (err.message || err.type))
      ? String(err.message || err.type)
      : '';
  const invalid = /invalid_request|rejected as invalid/i.test(raw);
  return {
    code: invalid ? 'MODEL_INVALID_REQUEST' : 'WORKRUN_FAILED',
    message: invalid
      ? 'The agent could not continue because its model request was rejected.'
      : 'The agent stopped before finishing. Work is saved.',
    retryable: true,
  };
}

/**
 * Map one AgentScope event onto the normalized vocabulary.
 *
 * Returns `null` for events that carry no UI-relevant information (token-level
 * deltas, model-call bookkeeping). Dropping them here rather than in the UI
 * keeps the persisted `events` array small — it is a progress log, not a
 * transcript, and the transcript already lives in `hyper_turns.lines`.
 *
 * @param {object} event  An AgentScope AgentEvent, already JSON-decoded.
 * @returns {object|null} A normalized event, or null to drop.
 */
export function normalizeAgentScopeEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const type = String(event.type || event.t || '').toUpperCase();
  const ts = Date.now();

  switch (type) {
    case 'REPLY_START':
      return { t: WORK_RUN_EVENT.STATUS, status: 'thinking', ts };

    case 'REPLY_END': {
      // AgentScope's ReplyFinishedReason is exactly: completed | interrupted |
      // exceed_max_iters | error. Only `completed` is a clean finish; the rest
      // mean the run stopped without finishing its work.
      const reason = event.finished_reason || event.reason || 'completed';
      const failed = reason !== 'completed';
      return {
        t: failed ? WORK_RUN_EVENT.FAILED : WORK_RUN_EVENT.STATUS,
        status: failed ? 'failed' : 'idle',
        reason,
        error: failed ? publicWorkRunError(event.error || reason) : null,
        ts,
      };
    }

    case 'TOOL_CALL_START': {
      const tool = event.tool_call_name || event.tool_name || event.name || null;
      return {
        t: isNativeTaskTool(tool) ? WORK_RUN_EVENT.PLAN : WORK_RUN_EVENT.TOOL_STARTED,
        tool,
        call_id: event.tool_call_id || event.id || null,
        family: isNativeTaskTool(tool) ? 'task' : null,
        ts,
      };
    }

    case 'TOOL_RESULT_END': {
      const tool = event.tool_call_name || event.tool_name || event.name || null;
      return {
        t: isNativeTaskTool(tool) ? WORK_RUN_EVENT.PLAN : WORK_RUN_EVENT.TOOL_COMPLETED,
        tool,
        call_id: event.tool_call_id || event.id || null,
        family: isNativeTaskTool(tool) ? 'task' : null,
        state: event.state || 'success',
        ts,
      };
    }

    case 'REQUIRE_USER_CONFIRM': {
      // RequireUserConfirmEvent carries `tool_calls` (a list), not a
      // `tool_name`/`prompt` pair. Reading the non-existent fields left every
      // approval request with a null tool and null prompt, so the UI could not
      // say what it was asking the operator to approve.
      const calls = Array.isArray(event.tool_calls) ? event.tool_calls : [];
      const first = calls[0] || {};
      return {
        t: WORK_RUN_EVENT.APPROVAL_REQUESTED,
        tool: first.name || first.tool_name || null,
        call_id: first.id || first.tool_call_id || null,
        reply_id: event.reply_id || null,
        tool_calls: calls,
        // The full set, so a multi-tool confirmation is not silently reduced
        // to its first entry.
        tools: calls.map((c) => c?.name || c?.tool_name || null).filter(Boolean),
        prompt: event.prompt || event.message || null,
        ts,
      };
    }

    case 'HINT_BLOCK':
      // Team messages and scheduled fires arrive as hints. `source` is ALWAYS
      // set on a HintBlockEvent (AgentScope documents it as the sender or
      // origin, e.g. "system"), so treating any source as a delegation emitted
      // a phantom team member for every system hint. A delegation is a hint
      // whose source is a real agent, not the runtime itself.
      if (event.source && event.source !== 'system') {
        return {
          t: WORK_RUN_EVENT.TEAM_MEMBER_STARTED,
          member: event.source,
          ts,
        };
      }
      return null;

    case 'CUSTOM': {
      // The runtime's own tools emit CustomEvent for things AgentScope has no
      // native event for — artifact writes and workspace allocation.
      const name = String(event.name || '');
      if (name === 'artifact.created') {
        return {
          t: WORK_RUN_EVENT.ARTIFACT_CREATED,
          artifact_id: event.value?.artifact_id || null,
          path: event.value?.path || null,
          content_type: event.value?.content_type || null,
          ts,
        };
      }
      if (name === 'workspace.started') {
        return {
          t: WORK_RUN_EVENT.WORKSPACE_STARTED,
          workspace_id: event.value?.workspace_id || null,
          backend: event.value?.backend || null,
          ts,
        };
      }
      if (name === 'state_updated') {
        const tasks = event.value?.tasks_context?.tasks;
        if (!Array.isArray(tasks)) return null;
        // AgentScope owns the complete task state. Persist only the compact
        // projection required to render/reconnect a WorkRun; never turn this
        // event log into a second task database.
        return {
          t: WORK_RUN_EVENT.PLAN,
          family: 'task',
          tasks: tasks.map((task) => ({
            id: task?.id || null,
            subject: task?.subject || '',
            description: task?.description || '',
            state: task?.state || null,
            blocked_by: Array.isArray(task?.blocked_by) ? task.blocked_by : [],
            owner: task?.owner || null,
          })),
          ts,
        };
      }
      return null;
    }

    default:
      // TEXT_BLOCK_*, THINKING_BLOCK_*, MODEL_CALL_*, TOOL_CALL_DELTA,
      // TOOL_RESULT_TEXT_DELTA — token-level noise for a progress log.
      return null;
  }
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/** Cap on the persisted progress log. It is a log, not a transcript. */
const MAX_EVENTS = 500;

/**
 * Append a normalized event to a run's log and advance its status if the event
 * implies one. Single UPDATE, so a concurrent append cannot lose the other's
 * write the way a read-modify-write would.
 *
 * @param {object} prisma
 * @param {string} workRunId
 * @param {object} normalized  Output of `normalizeAgentScopeEvent`.
 * @returns {Promise<object|null>} The updated run, or null when not found.
 */
export async function appendWorkRunEvent(prisma, workRunId, normalized) {
  if (!normalized) return null;

  // `events || '[]'::jsonb` guards against a NULL that predates the default.
  // The slice keeps the newest MAX_EVENTS — a long run must not grow the row
  // without bound.
  //
  // `$2::int` is load-bearing: Prisma binds a JS number as bigint, and Postgres
  // has no `jsonb -> bigint` operator — only `jsonb -> int`. Without the cast
  // every append fails with SQLSTATE 42883.
  const rows = await prisma.$queryRawUnsafe(
    `UPDATE "hivemind"."work_runs"
        SET events = (
              CASE
                WHEN jsonb_array_length(COALESCE(events, '[]'::jsonb)) >= $2::int
                  THEN (COALESCE(events, '[]'::jsonb) -> -($2::int - 1)) || jsonb_set($3::jsonb, '{0,seq}', to_jsonb(jsonb_array_length(COALESCE(events, '[]'::jsonb)) + 1))
                ELSE COALESCE(events, '[]'::jsonb) || jsonb_set($3::jsonb, '{0,seq}', to_jsonb(jsonb_array_length(COALESCE(events, '[]'::jsonb)) + 1))
              END
            ),
            heartbeat_at = now(),
            updated_at = now()
      WHERE id = $1::uuid
      RETURNING id, status, heartbeat_at`,
    workRunId,
    MAX_EVENTS,
    JSON.stringify([normalized]),
  );
  return rows?.[0] || null;
}

/**
 * Transition a run, rejecting illegal moves.
 *
 * The guard is in the WHERE clause, not a read-then-write: two concurrent
 * transitions (a completion racing a cancel) must not both succeed. A rejected
 * transition returns `{ ok: false, reason }` rather than throwing, because the
 * caller is usually an event handler that must not crash the request.
 *
 * @param {object} prisma
 * @param {string} workRunId
 * @param {string} to
 * @param {object} [patch]  Extra columns: error, result, agentscopeSessionId, …
 */
export async function transitionWorkRun(prisma, workRunId, to, patch = {}) {
  const current = await prisma.$queryRawUnsafe(
    'SELECT id, status FROM "hivemind"."work_runs" WHERE id = $1::uuid',
    workRunId,
  );
  const row = current?.[0];
  if (!row) return { ok: false, reason: 'not_found' };
  if (!canTransition(row.status, to)) {
    return { ok: false, reason: 'illegal_transition', from: row.status, to };
  }

  const sets = ['status = $2', 'updated_at = now()'];
  const params = [workRunId, to];
  // jsonb columns need an explicit cast: Prisma binds a JS string as `text`,
  // and Postgres will not implicitly coerce text -> jsonb in an UPDATE SET
  // (SQLSTATE 42804). The cast is per-column, not per-value.
  const push = (column, value, cast = '') => {
    params.push(value);
    sets.push(`${column} = $${params.length}${cast}`);
  };

  if (patch.error !== undefined) push('error', patch.error);
  if (patch.result !== undefined) push('result', JSON.stringify(patch.result), '::jsonb');
  if (patch.agentscopeSessionId !== undefined) push('agentscope_session_id', patch.agentscopeSessionId);
  if (patch.workspaceId !== undefined) push('workspace_id', patch.workspaceId);
  if (patch.teamId !== undefined) push('team_id', patch.teamId);
  if (patch.resultArtifactIds !== undefined) push('result_artifact_ids', JSON.stringify(patch.resultArtifactIds), '::jsonb');

  if (to === WORK_RUN_STATUS.RUNNING && !patch.keepStartedAt) {
    sets.push('started_at = COALESCE(started_at, now())');
  }
  if (isTerminal(to)) sets.push('completed_at = now()');

  const updated = await prisma.$queryRawUnsafe(
    `UPDATE "hivemind"."work_runs" SET ${sets.join(', ')}
      WHERE id = $1::uuid RETURNING *`,
    ...params,
  );
  return { ok: true, run: updated?.[0] || null };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export const RUNTIME_URL = () =>
  (process.env.HM_AGENT_RUNTIME_URL || 'http://hm-agent-runtime-v2:8000').replace(/\/+$/, '');

/**
 * Create a WorkRun and hand it to the agent runtime.
 *
 * Order matters and is not arbitrary:
 *
 *   1. Create the HyperTurn FIRST. The runtime's event-forwarding path posts to
 *      hm-core's inbound sink, which re-derives the execution identity from the
 *      persisted HyperTurn row and answers 409 on any mismatch. A run whose turn
 *      does not exist yet would forward events into a 409 wall.
 *   2. Create the WorkRun row, so a runtime failure still leaves a durable,
 *      inspectable record of the attempt rather than a lost request.
 *   3. Call the runtime. A failure here transitions the run to `failed` with the
 *      reason — never leaves it stuck in `starting`.
 *
 * @returns {Promise<{workRun: object, turnId: string, sessionId: string|null}>}
 */
export async function dispatchWorkRun({
  prisma,
  orgId,
  userId,
  goal,
  employeeId = null,
  roomId = null,
  hyperagentSlug = null,
  playbookId = null,
  playbookVersion = null,
  scope = {},
  chatModelConfig = null,
  logger = console,
}) {
  if (!orgId || !userId) throw new Error('orgId and userId are required');
  if (!goal || !String(goal).trim()) throw new Error('goal is required');

  // ── 1. The HyperTurn the runtime's identity contract resolves against ──
  // A WorkRun needs a room to hang the turn off. When the caller did not name
  // one, resolve the org's Company HQ room — the same room the UI's composer
  // posts into — so the run is visible in the existing room feed.
  let resolvedRoomId = roomId;
  if (!resolvedRoomId) {
    const hq = await prisma.$queryRawUnsafe(
      `SELECT id FROM "hivemind"."hyper_rooms"
        WHERE org_id = $1::uuid AND archived_at IS NULL
          AND agent_connectors ? '_company'
        ORDER BY created_at DESC LIMIT 1`,
      orgId,
    );
    resolvedRoomId = hq?.[0]?.id || null;
  }
  if (!resolvedRoomId) {
    throw new Error(
      'no room available for this WorkRun: pass room_id, or onboard the org so a Company HQ room exists',
    );
  }

  const turn = await prisma.$transaction(async (tx) => {
    const last = await tx.hyperTurn.findFirst({
      where: { roomId: resolvedRoomId },
      orderBy: { seq: 'desc' },
      select: { seq: true },
    });
    const seq = (last?.seq ?? 0) + 1;
    return tx.hyperTurn.create({
      data: {
        roomId: resolvedRoomId,
        seq,
        userMessage: String(goal).slice(0, 8000),
        status: 'live',
        idempotencyKey: `workrun:${resolvedRoomId}:${seq}:${Date.now()}`.slice(0, 64),
        lines: [],
      },
    });
  });

  // ── 2. The durable WorkRun row ──
  const created = await prisma.$queryRawUnsafe(
    `INSERT INTO "hivemind"."work_runs"
       (org_id, user_id, employee_id, room_id, turn_id, goal, status,
        hyperagent_slug, playbook_id, playbook_version, scope)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, 'queued',
             $7, $8, $9, $10::jsonb)
     RETURNING *`,
    orgId,
    userId,
    employeeId,
    resolvedRoomId,
    turn.id,
    String(goal),
    hyperagentSlug,
    playbookId,
    playbookVersion,
    JSON.stringify(scope || {}),
  );
  const workRun = created?.[0];
  if (!workRun) throw new Error('work_runs insert returned no row');

  await appendWorkRunEvent(prisma, workRun.id, {
    t: WORK_RUN_EVENT.STARTED,
    goal: String(goal).slice(0, 500),
    hyperagent: hyperagentSlug,
    playbook: playbookId,
    ts: Date.now(),
  });

  // ── 3. Hand it to the runtime ──
  await transitionWorkRun(prisma, workRun.id, WORK_RUN_STATUS.STARTING);

  // The runtime needs an agent record. When the caller named an employee, its
  // slug is the agent name the runtime resolves; otherwise the runtime creates
  // a one-off agent from the goal. Either way hm-core stays the authority on
  // *which* employee — the runtime only learns the resolved identity.
  let runtimeSessionId = null;
  try {
    const resp = await internalFetch(`${RUNTIME_URL()}/workrun/`, {
      service: 'hm-agent-runtime',
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: {
        workrun_id: workRun.id,
        agent_id: employeeId || hyperagentSlug || 'workrun-default',
        turn_id: turn.id,
        room_id: resolvedRoomId,
        org_id: orgId,
        goal: String(goal),
        hyperagent_slug: hyperagentSlug,
        playbook_id: playbookId,
        playbook_version: playbookVersion,
        scope: scope || {},
        ...(chatModelConfig ? { chat_model_config: chatModelConfig } : {}),
      },
      userId,
      orgId,
      timeoutMs: 30_000,
    });

    const payload = await resp.json().catch(() => ({}));
    if (!resp.ok) {
      throw new Error(payload.detail || payload.error || `runtime returned ${resp.status}`);
    }
    runtimeSessionId = payload.session_id || null;

    await transitionWorkRun(prisma, workRun.id, WORK_RUN_STATUS.RUNNING, {
      agentscopeSessionId: payload.session_id || null,
      workspaceId: payload.workspace_id || null,
    });
    logger.log?.(
      `[workrun] ${workRun.id} -> session ${payload.session_id} (turn ${turn.id})`,
    );
  } catch (err) {
    // A dispatch failure is a real failure, not a stuck run. Record the reason
    // so the UI can show it and an operator can act on it.
    logger.warn?.(`[workrun] dispatch failed for ${workRun.id}: ${err.message}`);
    await transitionWorkRun(prisma, workRun.id, WORK_RUN_STATUS.FAILED, {
      error: `runtime dispatch failed: ${err.message}`,
    });
    await appendWorkRunEvent(prisma, workRun.id, {
      t: WORK_RUN_EVENT.FAILED,
      error: publicWorkRunError(err.message),
      ts: Date.now(),
    });
    throw err;
  }

  const final = await prisma.$queryRawUnsafe(
    'SELECT * FROM "hivemind"."work_runs" WHERE id = $1::uuid',
    workRun.id,
  );
  return { workRun: final?.[0] || workRun, turnId: turn.id, sessionId: runtimeSessionId };
}

/**
 * Apply one inbound runtime event to its WorkRun.
 *
 * Called from the runtime's event-forwarding path. The event arrives in
 * AgentScope's vocabulary and is normalized here — the runtime does not need to
 * know the UI's event names, and the UI does not need to know AgentScope's.
 *
 * @returns {Promise<{applied: boolean, reason?: string}>}
 */
export async function applyRuntimeEvent(prisma, workRunId, agentScopeEvent) {
  const normalized = normalizeAgentScopeEvent(agentScopeEvent);
  if (!normalized) return { applied: false, reason: 'not_ui_relevant' };

  const run = await prisma.$queryRawUnsafe(
    'SELECT id, status, events FROM "hivemind"."work_runs" WHERE id = $1::uuid',
    workRunId,
  );
  const row = run?.[0];
  if (!row) return { applied: false, reason: 'not_found' };
  if (isTerminal(row.status)) return { applied: false, reason: 'terminal' };

  // AgentScope's TOOL_RESULT_END does not always repeat tool_call_name. The
  // call id is durable, so recover the original name from its matching start
  // event. This keeps one identifiable tool row in the UI instead of a
  // generic completed action or a duplicate row.
  if (
    normalized.t === WORK_RUN_EVENT.TOOL_COMPLETED
    && !normalized.tool
    && normalized.call_id
    && Array.isArray(row.events)
  ) {
    const started = [...row.events].reverse().find((event) => (
      event?.t === WORK_RUN_EVENT.TOOL_STARTED && event.call_id === normalized.call_id
    ));
    if (started?.tool) normalized.tool = started.tool;
  }

  await appendWorkRunEvent(prisma, workRunId, normalized);

  // An event may imply a status change. Only the ones that do are acted on —
  // a tool completing does not move the run, a reply ending does.
  if (normalized.t === WORK_RUN_EVENT.FAILED) {
    await transitionWorkRun(prisma, workRunId, WORK_RUN_STATUS.FAILED, {
      error: normalized.error || normalized.reason || 'agent run failed',
    });
  } else if (normalized.t === WORK_RUN_EVENT.APPROVAL_REQUESTED) {
    await transitionWorkRun(prisma, workRunId, WORK_RUN_STATUS.WAITING_APPROVAL);
  } else if (normalized.t === WORK_RUN_EVENT.ARTIFACT_CREATED && normalized.artifact_id) {
    const ids = await prisma.$queryRawUnsafe(
      'SELECT result_artifact_ids FROM "hivemind"."work_runs" WHERE id = $1::uuid',
      workRunId,
    );
    const existing = Array.isArray(ids?.[0]?.result_artifact_ids)
      ? ids[0].result_artifact_ids
      : [];
    if (!existing.includes(normalized.artifact_id)) {
      await prisma.$queryRawUnsafe(
        `UPDATE "hivemind"."work_runs"
            SET result_artifact_ids = $2::jsonb, updated_at = now()
          WHERE id = $1::uuid`,
        workRunId,
        JSON.stringify([...existing, normalized.artifact_id]),
      );
    }
  }

  return { applied: true };
}

/**
 * Complete a run. Called when the runtime reports the run finished — either
 * from a terminal event or from an explicit completion call.
 */
export async function completeWorkRun(prisma, workRunId, { result = {}, error = null } = {}) {
  const to = error ? WORK_RUN_STATUS.FAILED : WORK_RUN_STATUS.COMPLETED;
  const outcome = await transitionWorkRun(prisma, workRunId, to, {
    result,
    ...(error ? { error } : {}),
  });
  if (outcome.ok) {
    await appendWorkRunEvent(prisma, workRunId, {
      t: error ? WORK_RUN_EVENT.FAILED : WORK_RUN_EVENT.COMPLETED,
      ...(error ? { error: publicWorkRunError(error) } : { result }),
      ts: Date.now(),
    });
  }
  return outcome;
}

/**
 * Mark abandoned dispatches as failed without touching paused or approval-gated
 * work.  This is deliberately an operator/scheduler hook, not a timer inside
 * the WorkRun module: hm-core decides when a runtime is unavailable and only
 * one replica may perform recovery.
 *
 * @param {object} prisma
 * @param {{ before: Date, statuses?: string[], reason?: string }} options
 * @returns {Promise<{ attempted: number, failed: number, skipped: number }>}
 */
export async function failStaleWorkRuns(prisma, {
  before,
  statuses = [WORK_RUN_STATUS.STARTING, WORK_RUN_STATUS.RUNNING],
  reason = 'runtime heartbeat expired',
} = {}) {
  if (!(before instanceof Date) || Number.isNaN(before.valueOf())) {
    throw new Error('before must be a valid Date');
  }
  if (!Array.isArray(statuses) || statuses.length === 0) {
    throw new Error('statuses must be a non-empty array');
  }

  const rows = await prisma.$queryRawUnsafe(
    `SELECT id, status FROM "hivemind"."work_runs"
       WHERE status = ANY($1::text[])
         AND COALESCE(heartbeat_at, started_at, created_at) < $2::timestamptz`,
    statuses,
    before.toISOString(),
  );

  let failed = 0;
  let skipped = 0;
  for (const row of rows || []) {
    const outcome = await transitionWorkRun(prisma, row.id, WORK_RUN_STATUS.FAILED, { error: reason });
    if (!outcome.ok) {
      skipped += 1;
      continue;
    }
    failed += 1;
    await appendWorkRunEvent(prisma, row.id, {
      t: WORK_RUN_EVENT.FAILED,
      error: publicWorkRunError(reason),
      reason: 'stale_heartbeat',
      ts: Date.now(),
    });
  }
  return { attempted: (rows || []).length, failed, skipped };
}

export function describe() {
  return `runtime=${RUNTIME_URL()}`;
}

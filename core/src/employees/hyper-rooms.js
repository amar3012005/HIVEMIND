/**
 * Hyper Agents — Rooms + CSI Swarm runtime
 *
 * Slack-/WhatsApp-style multi-agent workspace backed by Cognitive Swarm
 * Intelligence on HIVEMIND. One persistent room per topic, persistent
 * participants, lead+reactors per user message, optional round-2
 * debate, sealed turns, JSONL event log.
 *
 * Reuses, does NOT duplicate:
 *   - core/src/employees/hyper-state.js  (per-agent state derivation)
 *   - control-plane forwardSidecar()      (auth + master-key plumbing)
 *   - sidecar /v1/team-tasks pattern      (multi-agent execution shape)
 *   - archive/prompt_variants + archive/evaluations (tuning artifacts)
 */

import crypto from 'node:crypto';
import { publishTurnEvent, publishTurnSeal } from '../realtime/hyper-turn-events.js';
import { appendHqEvent } from '../hq-runtime/repository.js';

// CSI role lanes. Maps from existing DigitalEmployee.roleArchetype
// (which may already be set) into one of these canonical lanes.
const ROLE_LANES = ['Strategist', 'Builder', 'Skeptic', 'Researcher', 'Communicator'];

// Adversarial pairs — when both ends are present in a room AND the
// current turn has a Lead in pair A, a Reactor in pair B must surface
// a challenge if any is available. Enforced by the quality gate.
const ADVERSARIAL_PAIRS = [
  ['Strategist', 'Skeptic'],
  ['Builder',    'Skeptic'],
  ['Communicator', 'Skeptic'],
];

const ROLE_LANE_HINTS = {
  Strategist:   ['strategy','plan','vision','direction','ceo','founder','pm'],
  Builder:      ['engineer','build','ship','code','architect','dev','cto','infra'],
  Skeptic:      ['critic','risk','adversar','challenge','qa','security','audit','review'],
  Researcher:   ['research','data','analy','science','study','inquir','curious','explore'],
  Communicator: ['comm','writer','market','copy','design','customer','support','sales'],
};

/**
 * Derive csi lane from an employee's persona / name / roleArchetype.
 * Deterministic — same inputs always pick the same lane. Used when
 * roleArchetype is null and we need a lane for room logic.
 */
const LEGACY_ROLE_MAP = {
  coordinator:  'Strategist',
  strategist:   'Strategist',
  operator:     'Strategist',
  investigator: 'Researcher',
  researcher:   'Researcher',
  analyst:      'Researcher',
  skeptic:      'Skeptic',
  critic:       'Skeptic',
  challenger:   'Skeptic',
  auditor:      'Skeptic',
  builder:      'Builder',
  engineer:     'Builder',
  developer:    'Builder',
  architect:    'Builder',
  communicator: 'Communicator',
  writer:       'Communicator',
  marketer:     'Communicator',
};

export function deriveCsiLane(employee) {
  if (!employee) return 'Communicator';
  const existing = String(employee.roleArchetype || '').trim();
  if (existing && ROLE_LANES.includes(existing)) return existing;
  const mapped = LEGACY_ROLE_MAP[existing.toLowerCase()];
  if (mapped) return mapped;

  const haystack = [
    employee.roleArchetype || '',
    employee.name || '',
    employee.slug || '',
    employee.persona || '',
  ].join(' ').toLowerCase();

  let best = 'Communicator';
  let bestScore = 0;
  for (const lane of ROLE_LANES) {
    const hints = ROLE_LANE_HINTS[lane] || [];
    let score = 0;
    for (const h of hints) {
      if (haystack.includes(h)) score += 1;
    }
    if (score > bestScore) { bestScore = score; best = lane; }
  }
  return best;
}

/**
 * For a given lead lane, return the set of opposing lanes that MUST
 * push back if present in the room (CSI debate-policy gate).
 */
export function opposingLanes(leadLane) {
  const out = new Set();
  for (const [a, b] of ADVERSARIAL_PAIRS) {
    if (a === leadLane) out.add(b);
    else if (b === leadLane) out.add(a);
  }
  return out;
}

/**
 * Hash a (room_id, seq, user_message) tuple into a stable idempotency
 * key so a re-submitted user message resolves to the same turn instead
 * of creating a second LLM run.
 */
export function buildIdempotencyKey({ roomId, seq, userMessage }) {
  return crypto
    .createHash('sha256')
    .update(`${roomId}:${seq}:${userMessage}`)
    .digest('hex')
    .slice(0, 64);
}

/**
 * Append a JSONL event to a HyperTurn.lines column transactionally.
 * Prisma jsonb arrays don't support atomic push, so we read-modify-write
 * inside a serializable transaction.
 *
 * @param {import('@prisma/client').PrismaClient} prisma
 * @param {string} turnId
 * @param {object} event   JSONL event ({t, ts, ...})
 */
export async function appendTurnEvent(prisma, turnId, event) {
  const result = await prisma.$transaction(async (tx) => {
    const row = await tx.hyperTurn.findUnique({
      where: { id: turnId },
      select: { lines: true },
    });
    if (!row) throw new Error(`HyperTurn not found: ${turnId}`);
    const lines = Array.isArray(row.lines) ? row.lines : [];
    const eventId = String(event?.event_id || '').trim();
    if (eventId) {
      const existing = lines.find((line) => String(line?.event_id || '') === eventId);
      if (existing) return { stamped: existing, appended: false };
    }
    const now = Date.now();
    const stamped = { ts: now, received_ts: now, ...event };
    lines.push(stamped);
    let activeAgents;
    if (event?.t === 'agent_activated' || event?.t === 'agent_assignment_started'
        || event?.t === 'agent_assignment_completed' || event?.t === 'agent_waiting') {
      const current = await tx.hyperTurn.findUnique({ where: { id: turnId }, select: { activeAgents: true } }).catch(() => null);
      const agents = Array.isArray(current?.activeAgents) ? [...current.activeAgents] : [];
      const key = String(event.agent_instance_id || event.agent || '');
      const index = agents.findIndex((agent) => String(agent.agent_instance_id || agent.agent || '') === key);
      const projection = {
        ...(index >= 0 ? agents[index] : {}),
        employee_slug: event.agent || null,
        agent_instance_id: event.agent_instance_id || null,
        status: event.t === 'agent_assignment_completed' ? 'complete'
          : event.t === 'agent_waiting' ? 'waiting'
            : event.t === 'agent_assignment_started' ? 'working' : 'active',
        updated_at: now,
      };
      if (index >= 0) agents[index] = projection; else agents.push(projection);
      activeAgents = agents;
    }
    await tx.hyperTurn.update({
      where: { id: turnId },
      data: { lines, ...(activeAgents ? { activeAgents } : {}) },
    });
    return { stamped, appended: true };
  });
  if (result.appended) publishTurnEvent(turnId, result.stamped);
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "hivemind"."hyper_turns" SET last_progress_at = NOW() WHERE id = $1::uuid`, turnId,
    );
  } catch { /* additive fail-safe migration may not be installed yet */ }
  return result.stamped;
}

/**
 * Seal a turn — final status + cost roll-up + sealed_at timestamp.
 * Idempotent: re-sealing is a no-op.
 */
export async function sealTurn(prisma, turnId, { status = 'complete', costTokens = 0, event = null } = {}) {
  const cur = await prisma.hyperTurn.findUnique({
    where: { id: turnId },
    select: { sealedAt: true, lines: true },
  });
  if (!cur) throw new Error(`HyperTurn not found: ${turnId}`);
  if (cur.sealedAt) return false; // already sealed
  const lines = Array.isArray(cur.lines) ? cur.lines : [];
  if (status === 'complete' && !lines.some((line) => line?.t === 'final_report')) {
    const synthesis = [...lines].reverse().find((line) => (
      line?.t === 'line' && line?.kind === 'synthesis' && String(line?.content || '').trim()
    ));
    if (synthesis) {
      await appendTurnEvent(prisma, turnId, {
        t: 'final_report',
        event_id: `recovered-final-report:${turnId}`,
        title: 'Final report',
        template: 'recovered_synthesis',
        status: 'complete',
        verdict: 'complete',
        content: String(synthesis.content).trim(),
        recovered_from: 'synthesis',
      });
    }
  }
  await appendTurnEvent(prisma, turnId, event || { t: 'seal', cost_tokens: costTokens, status });
  await prisma.hyperTurn.update({
    where: { id: turnId },
    data: { status, costTokens, sealedAt: new Date() },
  });
  try {
    await prisma.$executeRawUnsafe(
      `UPDATE "hivemind"."hyper_turns"
          SET execution_phase = 'SEALED', last_progress_at = NOW(),
              terminal_reason = COALESCE(terminal_reason, $2)
        WHERE id = $1::uuid`,
      turnId, status === 'complete' ? 'completed' : String(status || 'completed'),
    );
  } catch { /* historical schema remains readable during rollout */ }
  publishTurnSeal(turnId, { status, costTokens });
  return true;
}

/**
 * Drain durable Work Room events whose HTTP callback was lost. PostgreSQL is
 * the delivery truth; SSE is only a projection transport.
 */
export async function reconcileHyperTurnEventOutbox(prisma, { limit = 100 } = {}) {
  let rows = [];
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT o.id, o.turn_id, o.event
         FROM "hivemind"."hyper_turn_event_outbox" o
         JOIN "hivemind"."hyper_turns" t ON t.id = o.turn_id
         JOIN "hivemind"."hyper_rooms" r ON r.id = t.room_id
        WHERE o.delivered_at IS NULL AND r.room_mode = 'work'
        ORDER BY o.created_at ASC LIMIT $1`,
      Math.max(1, Math.min(500, Number(limit) || 100)),
    );
  } catch {
    return 0; // additive migration not installed yet
  }
  let delivered = 0;
  for (const row of rows) {
    const event = row.event && typeof row.event === 'object' ? row.event : {};
    try {
      if (event.t === 'seal') {
        await sealTurn(prisma, row.turn_id, {
          status: event.status || 'complete', costTokens: event.cost_tokens || 0, event,
        });
      } else {
        await appendTurnEvent(prisma, row.turn_id, event);
      }
      await prisma.$executeRawUnsafe(
        `UPDATE "hivemind"."hyper_turn_event_outbox" SET delivered_at = NOW() WHERE id = $1::uuid`, row.id,
      );
      delivered += 1;
    } catch {
      // Preserve pending order. A later maintenance tick resumes from this row.
    }
  }
  return delivered;
}

/**
 * Seal progressed Work Room turns from their durable candidate. This never
 * regenerates model work and therefore cannot duplicate tools or overwrite a
 * useful answer with a second whole-turn attempt.
 */
// Ops visibility (2026-08-16): a stranded/dead Work Room turn used to be
// silent by design outside a devops console — the founder's own HQ terminal
// never learned their task hit either reconciler. HyperTurn.runtime_playbook_run_id
// already links an HQ-dispatched turn straight back to its RuntimePlaybookRun
// (orgId + trigger.todo_id), which resolves to the owning HqTodo/HqRuntime —
// no new schema, just following a linkage that already exists. Reuses the
// SAME durable event log (hq_runtime_events via appendHqEvent) every other
// HQ narration this session writes into, rather than inventing a parallel
// ops-dashboard mechanism. A turn with no runtime_playbook_run_id (a manual/
// direct-chat room) is simply not HQ-owned work — correctly not narrated.
// Fails silently and never blocks the reconciler itself: losing a narration
// is far cheaper than losing the turn recovery/failure it describes.
export async function notifyOwningHqRuntime(prisma, {
  runtimePlaybookRunId, turnId, outcome, detail = {},
} = {}, { appendEvent = appendHqEvent } = {}) {
  if (!prisma || !runtimePlaybookRunId) return false;
  try {
    const run = await prisma.runtimePlaybookRun.findUnique({
      where: { id: runtimePlaybookRunId },
      select: { orgId: true, trigger: true },
    });
    const todoId = String(run?.trigger?.todo_id || '');
    if (!run || !todoId) return false;
    const todo = await prisma.hqTodo.findFirst({
      where: { id: todoId, orgId: run.orgId },
      select: { id: true, runtimeId: true, title: true },
    });
    if (!todo) return false;
    await appendEvent({
      prisma, runtimeId: todo.runtimeId, orgId: run.orgId,
      eventType: outcome === 'failed' ? 'blocked' : 'observation',
      title: outcome === 'failed'
        ? `A specialist Room turn stopped making progress: ${todo.title}`
        : `A specialist Room turn recovered from its last durable checkpoint: ${todo.title}`,
      summary: outcome === 'failed'
        ? 'The Work Room process restarted mid-turn and produced no recoverable answer. I marked the turn failed rather than leaving it silently spinning; the todo remains executable and another independent priority can proceed.'
        : 'The Work Room process restarted mid-turn, but a durable candidate answer already existed. I sealed the turn from that checkpoint instead of rerunning the work.',
      details: { turn_id: turnId, runtime_playbook_run_id: runtimePlaybookRunId, ...detail },
    });
    return true;
  } catch {
    return false;
  }
}

export async function reconcileStrandedWorkRoomTurns(prisma, {
  // A normal verifier + one bounded repair may consume three 90-second model
  // windows. Ten minutes avoids racing healthy work while still bounding stalls.
  staleBefore = new Date(Date.now() - 10 * 60 * 1000), limit = 50,
  notify = notifyOwningHqRuntime,
} = {}) {
  let rows = [];
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT t.id, t.candidate_output, t.verification_verdict, t.cost_tokens, t.runtime_playbook_run_id
         FROM "hivemind"."hyper_turns" t
         JOIN "hivemind"."hyper_rooms" r ON r.id = t.room_id
        WHERE t.status = 'live' AND t.sealed_at IS NULL AND r.room_mode = 'work'
          AND t.last_progress_at < $1
          AND (COALESCE(t.candidate_output->>'content', '') <> ''
               OR EXISTS (SELECT 1 FROM jsonb_array_elements(t.lines) e
                           WHERE e->>'t' = 'line' AND e->>'kind' = 'synthesis'))
        ORDER BY t.last_progress_at ASC LIMIT $2`,
      staleBefore, Math.max(1, Math.min(200, Number(limit) || 50)),
    );
  } catch {
    return 0;
  }
  let recovered = 0;
  for (const row of rows) {
    const candidate = row.candidate_output && typeof row.candidate_output === 'object'
      ? String(row.candidate_output.content || '').trim() : '';
    try {
      if (candidate) {
        await appendTurnEvent(prisma, row.id, {
          t: 'final_report', event_id: `reconciled-final-response:${row.id}`,
          title: 'Final response', template: 'reconciled_candidate', status: 'complete',
          content: candidate, recovered_from: 'candidate_output',
        });
      }
      await sealTurn(prisma, row.id, {
        status: 'complete', costTokens: Number(row.cost_tokens || 0),
        event: { t: 'seal', event_id: `reconciled-seal:${row.id}`, status: 'complete',
          cost_tokens: Number(row.cost_tokens || 0), recovered: true },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "hivemind"."hyper_turns"
            SET execution_phase = 'SEALED', terminal_reason = 'reconciled_from_durable_candidate',
                last_progress_at = NOW()
          WHERE id = $1::uuid`, row.id,
      );
      recovered += 1;
      await notify(prisma, { runtimePlaybookRunId: row.runtime_playbook_run_id, turnId: row.id, outcome: 'recovered' });
    } catch {
      // Idempotent events and seal make a later retry safe.
    }
  }
  return recovered;
}

/**
 * Fail turns that made genuinely NO recoverable progress and have gone
 * stale — the gap neither existing reconciler covers. The 15s sweeper above
 * only catches a turn whose INITIAL kick was dropped (zero lines, ~30s
 * window). reconcileStrandedWorkRoomTurns only recovers a Work Room turn
 * that reached a durable checkpoint (candidate_output or an existing
 * synthesis line) before dying. Neither catches the real remaining case:
 * hm-employees restarts mid-turn (e.g. mid-deploy — this happens routinely)
 * for a turn that already streamed some lines but produced no recoverable
 * answer. That turn sits status='live' forever with no seal, no error, and
 * the FE spins indefinitely. This marks it FAILED with an honest message
 * instead — never silently "complete" (nothing to recover), never left
 * hanging. Applies to every room mode, not just Work Rooms; an HQ work
 * order behind a now-failed turn is picked up by reconcileExpiredWorkOrders
 * once its lease expires, same as any other failure.
 */
export async function failDeadTurns(prisma, {
  // Generous relative to the sweeper's 30s window and the stranded-turn
  // reconciler's 10-minute checkpoint wait — this is the LAST resort for a
  // turn neither of those could recover, so it only fires once both have had
  // a real chance to.
  staleBefore = new Date(Date.now() - 15 * 60 * 1000), limit = 50,
  notify = notifyOwningHqRuntime,
} = {}) {
  let rows = [];
  try {
    rows = await prisma.$queryRawUnsafe(
      `SELECT t.id, t.runtime_playbook_run_id
         FROM "hivemind"."hyper_turns" t
        WHERE t.status = 'live' AND t.sealed_at IS NULL
          AND t.last_progress_at < $1
          AND COALESCE(t.candidate_output->>'content', '') = ''
          AND NOT EXISTS (SELECT 1 FROM jsonb_array_elements(t.lines) e
                           WHERE e->>'t' = 'line' AND e->>'kind' = 'synthesis')
        ORDER BY t.last_progress_at ASC LIMIT $2`,
      staleBefore, Math.max(1, Math.min(200, Number(limit) || 50)),
    );
  } catch {
    return 0;
  }
  let failed = 0;
  for (const row of rows) {
    try {
      await sealTurn(prisma, row.id, {
        status: 'failed', costTokens: 0,
        event: {
          t: 'seal', event_id: `dead-turn-failed:${row.id}`, status: 'failed',
          error: 'This turn stopped making progress (the service likely restarted mid-turn) '
            + 'and could not be recovered. Please retry.',
          recovered: false,
        },
      });
      await prisma.$executeRawUnsafe(
        `UPDATE "hivemind"."hyper_turns"
            SET terminal_reason = 'dead_turn_no_recoverable_checkpoint', last_progress_at = NOW()
          WHERE id = $1::uuid`, row.id,
      );
      failed += 1;
      await notify(prisma, { runtimePlaybookRunId: row.runtime_playbook_run_id, turnId: row.id, outcome: 'failed' });
    } catch {
      // Idempotent seal + write; a later retry of this reconciler is safe.
    }
  }
  return failed;
}

/**
 * Build the "is this room ready for a turn?" preflight check.
 * Returns null if OK, or an error object {code, message} for the caller.
 */
export function preflightTurn({ room, userMessage }) {
  if (!room) return { code: 'room_not_found', message: 'Room not found' };
  if (room.archivedAt) return { code: 'room_archived', message: 'Room is archived' };
  if (!Array.isArray(room.participantIds) || room.participantIds.length === 0) {
    return { code: 'no_participants', message: 'Room has no agents yet' };
  }
  if (!userMessage || !String(userMessage).trim()) {
    return { code: 'empty_message', message: 'user_message is required' };
  }
  if (String(userMessage).length > 8000) {
    return { code: 'message_too_long', message: 'user_message exceeds 8k chars' };
  }
  return null;
}

export const HYPER_CONFIG = {
  // Cost caps — effectively unlimited per user request; large numbers
  // only as runaway safety net.
  TURN_COST_CAP: 10_000_000,
  LEAD_MAX_TOKENS: 100_000,
  REACTOR_MAX_TOKENS: 100_000,
  REVISE_MAX_TOKENS: 100_000,
  // Reactors (Q9)
  MAX_REACTORS: 2,
  // Rounds (Q9)
  MAX_ROUNDS: 2,
  ROUND_2_CHALLENGE_THRESHOLD: 0.7,
  // Eval cadence (Q5)
  EVALS_PER_TUNE: 20,
  SHADOW_RUN_COUNT: 10,
  PROMO_AUTO_DELTA: 0.10,
  PROMO_GATED_DELTA_MIN: 0.02,
};

/**
 * Compute the 4-axis weighted score given individual sub-scores.
 * Weights mirror the spec (Section 6).
 */
export function weightedScore({ helpful = 0, role_fit = 0, evidence = 0, opposition = 0 }) {
  return helpful * 0.30 + role_fit * 0.25 + evidence * 0.20 + opposition * 0.25;
}

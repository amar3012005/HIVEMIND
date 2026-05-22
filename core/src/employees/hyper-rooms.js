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
export function deriveCsiLane(employee) {
  if (!employee) return 'Communicator';
  const existing = String(employee.roleArchetype || '').trim();
  if (existing && ROLE_LANES.includes(existing)) return existing;

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
  return prisma.$transaction(async (tx) => {
    const row = await tx.hyperTurn.findUnique({
      where: { id: turnId },
      select: { lines: true },
    });
    if (!row) throw new Error(`HyperTurn not found: ${turnId}`);
    const lines = Array.isArray(row.lines) ? row.lines : [];
    const stamped = { ts: Date.now(), ...event };
    lines.push(stamped);
    await tx.hyperTurn.update({
      where: { id: turnId },
      data: { lines },
    });
    return stamped;
  });
}

/**
 * Seal a turn — final status + cost roll-up + sealed_at timestamp.
 * Idempotent: re-sealing is a no-op.
 */
export async function sealTurn(prisma, turnId, { status = 'complete', costTokens = 0 } = {}) {
  const cur = await prisma.hyperTurn.findUnique({
    where: { id: turnId },
    select: { sealedAt: true },
  });
  if (!cur) throw new Error(`HyperTurn not found: ${turnId}`);
  if (cur.sealedAt) return false; // already sealed
  await appendTurnEvent(prisma, turnId, { t: 'seal', cost_tokens: costTokens, status });
  await prisma.hyperTurn.update({
    where: { id: turnId },
    data: { status, costTokens, sealedAt: new Date() },
  });
  return true;
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
  // Cost caps (Q9 lock)
  TURN_COST_CAP: 12_000,
  LEAD_MAX_TOKENS: 8192,
  REACTOR_MAX_TOKENS: 1500,
  REVISE_MAX_TOKENS: 4096,
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

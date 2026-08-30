// HyperAgents cross-runtime seam contracts (P1).
//
// The control-plane (JS) and the employees sidecar (Python/pydantic) talk over four
// HTTP seams. This module is the SINGLE SOURCE OF TRUTH for their payload shapes and
// the version-tolerance rules, so the two runtimes cannot drift silently.
//
// The four seams:
//   1. room-turn     control → sidecar  POST /internal/hyper/room-turn   (RoomTurnRequest)
//   2. turn-event    sidecar → control  POST /internal/hyper/turn-event  (TurnEvent)
//   3. team-task     control → sidecar  POST /internal/hyper/team-tasks  (CreateTeamTaskRequest)
//   4. employee-chat control → sidecar  POST /v1/employees/{slug}/chat   (ChatRequest)
//
// Version-tolerance contract (BOTH runtimes MUST honour it):
//   • Forward:  a receiver IGNORES unknown fields (never 400 on a newer sender). The
//               pydantic models set `model_config = ConfigDict(extra="ignore")`; the JS
//               normalizers below copy only known keys.
//   • Backward: every non-essential field is OPTIONAL with a default (an older sender
//               that omits a field is accepted). Builders DROP undefined so omission,
//               not null, is sent.
//   • schema_version is an optional negotiation hint, not a gate — a mismatch never rejects.
//
// Adoption: builders/normalizers here are the canonical path. `dispatchHyperRoomTurn`
// stamps the version via buildRoomTurnPayload; remaining inline call sites in
// control-plane-server.js already emit compatible tolerant shapes and should migrate to
// buildRoomTurnPayload incrementally (they are not rewritten in one pass to avoid churning
// the live room flow).

/** Current seam contract version. Bump only on a breaking shape change (rare). */
export const SEAM_SCHEMA_VERSION = '1';

/** Known room-turn request fields (mirrors pydantic RoomTurnRequest). Order is documentation only. */
export const ROOM_TURN_FIELDS = [
  'room_id', 'turn_id', 'user_id', 'org_id', 'user_message', 'participant_ids',
  'callback_url', 'flyby_decision', 'flyby_spec', 'project_id', 'room_goal',
  'task_tag', 'campaign_id', 'campaign_brief', 'display_message', 'execution_context',
  'sim_mode', 'sim_agents', 'evo_mode', 'write_policy', 'agentic_model', 'language',
  'execution_identity',
  'grok_runtime_mode', 'grok_runtime_version', 'grok_workflow_instance_id',
  'schema_version',
];

/** Required room-turn fields — a builder throws if any is missing/empty (fail fast, not at the sidecar). */
export const ROOM_TURN_REQUIRED = ['room_id', 'turn_id', 'user_id', 'org_id', 'user_message'];

/**
 * Build a version-tolerant room-turn payload: keep only known keys, DROP undefined/null
 * (so omission—not null—is sent), and stamp schema_version if absent.
 * @param {Object} fields
 * @returns {Object} payload ready for POST /internal/hyper/room-turn
 */
export function buildRoomTurnPayload(fields = {}) {
  const out = {};
  for (const k of ROOM_TURN_FIELDS) {
    if (fields[k] !== undefined && fields[k] !== null) out[k] = fields[k];
  }
  const missing = ROOM_TURN_REQUIRED.filter((k) => out[k] === undefined || out[k] === '');
  if (missing.length) {
    throw new Error(`buildRoomTurnPayload: missing required field(s): ${missing.join(', ')}`);
  }
  if (out.schema_version === undefined) out.schema_version = SEAM_SCHEMA_VERSION;
  return out;
}

/**
 * Immutable identity for a human Work Room execution. The turn id is also the
 * execution id: one persisted user turn owns one Director run and every event,
 * work order, verification and repair produced by it.
 */
export function buildWorkRoomExecutionIdentity(fields = {}) {
  const required = ['room_id', 'turn_id', 'user_id', 'org_id'];
  const missing = required.filter((key) => !String(fields[key] || '').trim());
  if (missing.length) {
    throw new Error(`buildWorkRoomExecutionIdentity: missing required field(s): ${missing.join(', ')}`);
  }
  return Object.freeze({
    contract: 'work-room-execution.v1',
    execution_id: String(fields.turn_id),
    room_id: String(fields.room_id),
    turn_id: String(fields.turn_id),
    user_id: String(fields.user_id),
    org_id: String(fields.org_id),
    epoch: 1,
  });
}

/**
 * Normalize an incoming turn-event (sidecar → control). Tolerant: defaults missing
 * fields, ignores unknown ones, never throws on shape. Shape: { turn_id, event:{t,...} }.
 * @param {Object} body raw parsed JSON
 * @returns {{turn_id: (string|null), schema_version: (string|null), event: Object}}
 */
export function normalizeTurnEvent(body = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const event = b.event && typeof b.event === 'object' ? b.event : {};
  return {
    turn_id: b.turn_id != null ? String(b.turn_id) : null,
    schema_version: b.schema_version != null ? String(b.schema_version) : null,
    event: {
      // preserve every event field verbatim first (forward-tolerant), then pin the
      // three the control plane relies on with safe defaults.
      ...event,
      t: event.t != null ? String(event.t) : 'unknown',
      status: event.status != null ? String(event.status) : 'complete',
      cost_tokens: Number.isFinite(Number(event.cost_tokens)) ? Number(event.cost_tokens) : 0,
    },
  };
}

export const CHAT_MODES = ['off', 'shadow', 'session', 'workflow', 'full'] as const;
export type ChatMode = typeof CHAT_MODES[number];

export type SessionMetadata = {
  event_id?: string;
  run_id?: string | null;
  turn_id: string;
  mode?: ChatMode;
  sequence?: number;
  event_type?: string;
  phase: string;
  status: string;
  trace_id?: string | null;
  state?: string | null;
  occurred_at: string;
};

export type ChatTurnWorkflowParams = { turn_id: string; mode: ChatMode };

const ALLOWED_KEYS = new Set([
  'event_id', 'run_id', 'turn_id', 'mode', 'sequence', 'event_type', 'phase', 'status', 'state', 'trace_id', 'occurred_at',
]);
const FORBIDDEN_KEYS = /(message|content|prompt|answer|response|memory|evidence|citation|source|tool|artifact|email|name)/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function validateMetadata(input: unknown): SessionMetadata {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('metadata_object_required');
  const record = input as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!ALLOWED_KEYS.has(key) || FORBIDDEN_KEYS.test(key)) throw new Error(`metadata_key_forbidden:${key}`);
  }
  if (!UUID.test(String(record.turn_id || ''))) throw new Error('invalid_turn_id');
  if (!record.phase || String(record.phase).length > 40) throw new Error('invalid_phase');
  if (!record.status || String(record.status).length > 32) throw new Error('invalid_status');
  if (!record.occurred_at || !Number.isFinite(Date.parse(String(record.occurred_at)))) throw new Error('invalid_occurred_at');
  if (record.mode != null && !CHAT_MODES.includes(record.mode as ChatMode)) throw new Error('invalid_mode');
  if (record.sequence != null && (!Number.isInteger(record.sequence) || Number(record.sequence) < 0)) throw new Error('invalid_sequence');
  if (record.event_type != null && String(record.event_type).length > 80) throw new Error('invalid_event_type');
  if (record.event_id != null && String(record.event_id).length > 160) throw new Error('invalid_event_id');
  if (record.run_id != null && String(record.run_id).length > 80) throw new Error('invalid_run_id');
  if (record.state != null && String(record.state).length > 40) throw new Error('invalid_state');
  if (record.trace_id != null && String(record.trace_id).length > 64) throw new Error('invalid_trace_id');
  return record as SessionMetadata;
}

export function validateWorkflowParams(input: unknown): ChatTurnWorkflowParams {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('workflow_params_required');
  const record = input as Record<string, unknown>;
  if (Object.keys(record).some((key) => !['turn_id', 'mode'].includes(key) || FORBIDDEN_KEYS.test(key))) {
    throw new Error('workflow_params_forbidden');
  }
  if (!UUID.test(String(record.turn_id || ''))) throw new Error('invalid_turn_id');
  if (!CHAT_MODES.includes(record.mode as ChatMode)) throw new Error('invalid_mode');
  return record as ChatTurnWorkflowParams;
}

export function isTerminalMetadata(input: SessionMetadata): boolean {
  return ['completed', 'failed', 'cancelled'].includes(input.status);
}

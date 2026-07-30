export const HQ_RUNTIME_STATES = Object.freeze([
  'INACTIVE', 'OBSERVING', 'DIAGNOSING', 'DELEGATING',
  'WAITING', 'REVIEWING', 'BLOCKED', 'PAUSED',
]);

export const HQ_EVENT_TYPES = Object.freeze([
  'wake', 'context_loaded', 'skill_loaded', 'tool_started', 'tool_result',
  'observation', 'decision', 'work_order_created', 'work_order_completed',
  'approval_required', 'verification', 'schedule_created', 'blocked', 'sleep',
  'instruction_received', 'todo_created', 'capability_required', 'capability_resolved',
]);

export const HQ_TRANSITIONS = Object.freeze({
  INACTIVE: ['OBSERVING', 'PAUSED'],
  OBSERVING: ['DIAGNOSING', 'WAITING', 'BLOCKED', 'PAUSED'],
  DIAGNOSING: ['DELEGATING', 'WAITING', 'BLOCKED', 'PAUSED'],
  DELEGATING: ['WAITING', 'BLOCKED', 'PAUSED'],
  WAITING: ['OBSERVING', 'REVIEWING', 'BLOCKED', 'PAUSED'],
  REVIEWING: ['DIAGNOSING', 'DELEGATING', 'WAITING', 'BLOCKED', 'PAUSED'],
  BLOCKED: ['OBSERVING', 'WAITING', 'PAUSED'],
  PAUSED: ['OBSERVING'],
});

export function assertHqTransition(from, to) {
  if (!HQ_RUNTIME_STATES.includes(from) || !HQ_RUNTIME_STATES.includes(to)) {
    throw new Error(`hq_runtime_unknown_state:${from}:${to}`);
  }
  if (!(HQ_TRANSITIONS[from] || []).includes(to)) {
    throw new Error(`hq_runtime_invalid_transition:${from}:${to}`);
  }
}

export function normalizeAuthorityPolicy(value = {}) {
  return {
    internal_autonomy: value.internal_autonomy !== false,
    external_writes: value.external_writes || 'approval_required',
    spending: value.spending || 'approval_required',
    deletion: value.deletion || 'approval_required',
    policy_changes: value.policy_changes || 'approval_required',
    emergency_stop: value.emergency_stop !== false,
  };
}

export function validateWorkResultPacket(value) {
  const packet = value && typeof value === 'object' ? value : {};
  const recommendation = String(packet.recommendation || 'escalate').toLowerCase();
  if (!['continue', 'iterate', 'pause', 'complete', 'escalate'].includes(recommendation)) {
    throw new Error('hq_work_result_invalid_recommendation');
  }
  return {
    result: packet.result && typeof packet.result === 'object' ? packet.result : {},
    actions: Array.isArray(packet.actions) ? packet.actions : [],
    metrics: packet.metrics && typeof packet.metrics === 'object' ? packet.metrics : {},
    cost: packet.cost && typeof packet.cost === 'object' ? packet.cost : {},
    failures: Array.isArray(packet.failures) ? packet.failures : [],
    blockers: Array.isArray(packet.blockers) ? packet.blockers : [],
    recommendation,
    source_refs: Array.isArray(packet.source_refs) ? packet.source_refs : [],
  };
}

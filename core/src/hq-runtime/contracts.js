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
  const legacyOverrides = Object.fromEntries(Object.entries(value)
    .filter(([key, preference]) => key.startsWith('outbound_') && ['manual', 'auto'].includes(preference)));
  const suppliedOverrides = value.gate_overrides && typeof value.gate_overrides === 'object' && !Array.isArray(value.gate_overrides)
    ? Object.fromEntries(Object.entries(value.gate_overrides)
      .filter(([key, preference]) => /^[a-z0-9_.:-]{1,120}$/i.test(key) && ['manual', 'auto'].includes(preference)))
    : {};
  const externalDefault = ['manual', 'auto'].includes(value.external_default)
    ? value.external_default
    : ['manual', 'auto'].includes(value.external_writes) ? value.external_writes : 'unconfigured';
  return {
    internal_autonomy: value.internal_autonomy !== false,
    external_writes: value.external_writes || 'approval_required',
    external_default: externalDefault,
    gate_overrides: { ...legacyOverrides, ...suppliedOverrides },
    outbound_messages: value.outbound_messages || 'unconfigured',
    outbound_calls: value.outbound_calls || 'unconfigured',
    outbound_campaigns: value.outbound_campaigns || 'unconfigured',
    spending: value.spending || 'approval_required',
    deletion: value.deletion || 'approval_required',
    policy_changes: value.policy_changes || 'approval_required',
    emergency_stop: value.emergency_stop !== false,
  };
}

export function resolveAuthorityPreference(value = {}, policyKey = null) {
  const policy = normalizeAuthorityPolicy(value);
  if (policyKey && ['manual', 'auto'].includes(policy.gate_overrides?.[policyKey])) {
    return policy.gate_overrides[policyKey];
  }
  return policy.external_default;
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

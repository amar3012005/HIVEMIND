/**
 * HIVE Routine contract over AgentScope's native scheduler.
 *
 * HIVE owns the governed routine identity and lifecycle; AgentScope owns the
 * timer and schedule execution. This module contains only deterministic data
 * translation and idempotency rules. It deliberately does not create timers.
 */

export const ROUTINE_STATUS = Object.freeze({
  ACTIVE: 'active',
  PAUSED: 'paused',
  ARCHIVED: 'archived',
});

const ROUTINE_TRANSITIONS = Object.freeze({
  [ROUTINE_STATUS.ACTIVE]: [ROUTINE_STATUS.PAUSED, ROUTINE_STATUS.ARCHIVED],
  [ROUTINE_STATUS.PAUSED]: [ROUTINE_STATUS.ACTIVE, ROUTINE_STATUS.ARCHIVED],
  [ROUTINE_STATUS.ARCHIVED]: [],
});

export function canTransitionRoutine(from, to) {
  if (from === to) return true;
  return (ROUTINE_TRANSITIONS[from] || []).includes(to);
}

function requiredString(value, field) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) throw new TypeError(`${field} is required`);
  return normalized;
}

/** AgentScope ScheduleData requires a complete ChatModelConfig. */
export function normalizeChatModelConfig(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('chat_model_config is required');
  }
  const config = {
    type: requiredString(input.type, 'chat_model_config.type'),
    credential_id: requiredString(input.credential_id, 'chat_model_config.credential_id'),
    model: requiredString(input.model, 'chat_model_config.model'),
    parameters: input.parameters && typeof input.parameters === 'object' && !Array.isArray(input.parameters)
      ? input.parameters
      : {},
  };
  return Object.freeze(config);
}

/** Validate the HIVE-owned fields before a native schedule is created. */
export function normalizeRoutineInput(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('routine must be an object');
  }
  const scheduleType = requiredString(input.schedule_type, 'schedule_type');
  if (scheduleType !== 'cron') throw new TypeError('schedule_type must be cron for AgentScope native schedules');
  const scheduleExpression = requiredString(input.schedule_expression, 'schedule_expression');
  const goal = requiredString(input.goal, 'goal');
  const playbookId = requiredString(input.playbook_id, 'playbook_id');
  const playbookVersion = Number(input.playbook_version);
  if (!Number.isInteger(playbookVersion) || playbookVersion < 1) {
    throw new TypeError('playbook_version must be a positive integer');
  }
  const status = input.status || ROUTINE_STATUS.ACTIVE;
  if (!Object.values(ROUTINE_STATUS).includes(status)) {
    throw new TypeError(`unsupported routine status: ${status}`);
  }
  return Object.freeze({
    room_id: requiredString(input.room_id, 'room_id'),
    agent_runtime_id: requiredString(input.agent_runtime_id || input.agent_id, 'agent_id'),
    playbook_id: playbookId,
    playbook_version: playbookVersion,
    schedule_type: scheduleType,
    schedule_expression: scheduleExpression,
    goal,
    authority_policy: input.authority_policy && typeof input.authority_policy === 'object'
      ? input.authority_policy
      : {},
    status,
  });
}

/**
 * Project a routine into AgentScope's native schedule payload.
 *
 * `description` is an opaque HIVE envelope. AgentScope stores and delivers it
 * as a scheduled hint; the runtime bridge uses the routine id to hand the fire
 * back to hm-core for WorkRun governance.
 */
export function nativeScheduleProjection({ routine, routineId, agentId, chatModelConfig }) {
  const normalized = normalizeRoutineInput(routine);
  return {
    agent_id: requiredString(agentId, 'agent_id'),
    name: `hive-routine:${requiredString(routineId, 'routine_id')}`,
    description: JSON.stringify({
      kind: 'hive_routine_fire',
      routine_id: routineId,
      playbook_id: normalized.playbook_id,
      playbook_version: normalized.playbook_version,
      goal: normalized.goal,
    }),
    cron_expression: normalized.schedule_expression,
    timezone: routine.timezone || 'UTC',
    enabled: normalized.status === ROUTINE_STATUS.ACTIVE,
    stateful: false,
    permission_mode: 'bypass',
    chat_model_config: normalizeChatModelConfig(chatModelConfig),
  };
}

/** Stable key for one scheduled fire. The timestamp comes from the scheduler. */
export function routineFireKey(routineId, scheduledAt) {
  const id = requiredString(routineId, 'routine_id');
  const instant = new Date(scheduledAt);
  if (Number.isNaN(instant.valueOf())) throw new TypeError('scheduled_at must be a valid date');
  return `routine:${id}:fire:${instant.toISOString()}`;
}

/** Scope projection handed to dispatchWorkRun; no provider payloads included. */
export function routineWorkRunScope({ routine, routineId, fireKey, scheduledAt }) {
  const normalized = normalizeRoutineInput(routine);
  return {
    routine_id: requiredString(routineId, 'routine_id'),
    routine_fire_key: requiredString(fireKey, 'fire_key'),
    scheduled_at: new Date(scheduledAt).toISOString(),
    playbook_id: normalized.playbook_id,
    playbook_version: normalized.playbook_version,
    authority_policy: normalized.authority_policy,
    goal: normalized.goal,
  };
}

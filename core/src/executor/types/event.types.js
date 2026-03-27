/**
 * Trail Executor — Event Type Contracts
 * HIVE-MIND Cognitive Runtime
 *
 * Structured event log for observability, replay, and audit.
 */

/**
 * A single execution event emitted by the runtime.
 *
 * @typedef {Object} ExecutionEvent
 * @property {import('./agent.types.js').EventId} id - Unique event identifier
 * @property {'step_start' | 'step_end' | 'trail_created' | 'trail_completed' | 'trail_failed' | 'trail_abandoned' | 'routing_decision' | 'lease_acquired' | 'lease_released' | 'budget_warning' | 'budget_exceeded' | 'session_rotated' | 'observation' | 'promotion_queued' | 'error'} type
 * @property {import('./agent.types.js').TrailId} [trailId] - Associated trail (if applicable)
 * @property {import('./agent.types.js').GoalId} goalId - Goal context
 * @property {import('./agent.types.js').NamespaceId} namespaceId
 * @property {Record<string, *>} payload - Event-specific data
 * @property {number} timestamp - Unix epoch ms
 * @property {number} [sequenceNo] - Monotonically increasing sequence within the session
 */

export const EVENT_TYPES = Symbol.for('hivemind.executor.event.types');

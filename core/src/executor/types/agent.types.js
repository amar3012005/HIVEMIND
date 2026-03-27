/**
 * Trail Executor — Agent Type Contracts
 * HIVE-MIND Cognitive Runtime
 *
 * Branded string types for domain identifiers,
 * execution configuration, budgets, and results.
 */

/**
 * Namespace scoping identifier (tenant / org boundary).
 * @typedef {string} NamespaceId
 */

/**
 * Unique agent identity within a namespace.
 * @typedef {string} AgentId
 */

/**
 * Reference to a declared goal the executor is pursuing.
 * @typedef {string} GoalId
 */

/**
 * Unique trail identifier (one execution path toward a goal).
 * @typedef {string} TrailId
 */

/**
 * Opaque event identifier for the execution event log.
 * @typedef {string} EventId
 */

/**
 * Lease token that proves ownership of a trail step.
 * @typedef {string} LeaseId
 */

/**
 * Identifier for a memory-promotion candidate queued for graph storage.
 * @typedef {string} PromotionCandidateId
 */

/**
 * Top-level runtime configuration for a single executor session.
 *
 * @typedef {Object} ExecutionConfig
 * @property {NamespaceId} namespaceId - Tenant / org boundary
 * @property {AgentId} agentId - Agent running this session
 * @property {GoalId} goalId - Goal being pursued
 * @property {ExecutionBudget} budget - Resource budget for the session
 * @property {import('./routing.types.js').RoutingConfig} routing - Trail selection config
 * @property {SessionRotationConfig} [sessionRotation] - Optional session rotation policy
 * @property {number} [maxConcurrentTrails] - Max trails evaluated in parallel (default: 1)
 * @property {boolean} [dryRun] - If true, actions are validated but not executed
 */

/**
 * Resource budget that the executor must not exceed.
 *
 * @typedef {Object} ExecutionBudget
 * @property {number} maxSteps - Hard ceiling on total steps across all trails
 * @property {number} maxTokens - Aggregate token budget (prompt + completion)
 * @property {number} maxWallClockMs - Wall-clock timeout in milliseconds
 * @property {number} [maxCostCents] - Optional monetary cost ceiling in cents
 */

/**
 * Policy for rotating the underlying LLM session to keep context fresh.
 *
 * @typedef {Object} SessionRotationConfig
 * @property {number} maxTurnsPerSession - Rotate after N turns
 * @property {number} [overlapTurns] - Turns to carry over into the new session (default: 2)
 * @property {boolean} [compactOnRotate] - Run working-memory compaction on rotate (default: true)
 */

/**
 * Final result returned when the executor finishes (success, failure, or budget-exceeded).
 *
 * @typedef {Object} ExecutionResult
 * @property {'completed' | 'failed' | 'budget_exceeded' | 'cancelled'} status
 * @property {GoalId} goalId
 * @property {import('./trail.types.js').TrailId} selectedTrailId - Trail that produced the result
 * @property {*} [output] - Arbitrary structured output from the final step
 * @property {WorkingMemorySnapshot} workingMemory - Snapshot at termination
 * @property {{ steps: number, tokens: number, wallClockMs: number, costCents?: number }} usage
 * @property {string} [error] - Human-readable error when status is 'failed'
 */

/**
 * Point-in-time snapshot of the executor's working memory.
 *
 * @typedef {Object} WorkingMemorySnapshot
 * @property {Observation[]} observations - Accumulated observations
 * @property {import('./trail.types.js').TrailStepSummary[]} stepSummaries - Condensed step history
 * @property {Record<string, *>} scratchpad - Free-form key/value scratch space
 * @property {number} tokenEstimate - Estimated token count of this snapshot
 */

/**
 * A single observation surfaced during execution (tool output, recall hit, user message, etc.).
 *
 * @typedef {Object} Observation
 * @property {EventId} eventId - Originating event
 * @property {'tool_output' | 'recall_hit' | 'user_message' | 'system' | 'error'} kind
 * @property {string} content - Textual payload
 * @property {Record<string, *>} [metadata] - Optional structured metadata
 * @property {number} timestamp - Unix epoch ms
 */

// Re-export markers (values) so downstream `import` works at runtime.
// The actual types are consumed via JSDoc only.
export const AGENT_TYPES = Symbol.for('hivemind.executor.agent.types');

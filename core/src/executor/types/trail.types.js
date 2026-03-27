/**
 * Trail Executor — Trail Type Contracts
 * HIVE-MIND Cognitive Runtime
 *
 * Trail lifecycle states, step summaries, and action references.
 */

/**
 * High-level trail lifecycle status.
 * @typedef {'pending' | 'active' | 'paused' | 'completed' | 'failed' | 'abandoned'} TrailStatus
 */

/**
 * Individual step lifecycle status within a trail.
 * @typedef {'planned' | 'running' | 'succeeded' | 'failed' | 'skipped'} StepStatus
 */

/**
 * A single execution trail — one candidate path toward a goal.
 *
 * @typedef {Object} Trail
 * @property {import('./agent.types.js').TrailId} id
 * @property {import('./agent.types.js').GoalId} goalId
 * @property {import('./agent.types.js').NamespaceId} namespaceId
 * @property {TrailStatus} status
 * @property {number} priority - Lower is higher priority (0 = top)
 * @property {TrailStepSummary[]} steps - Ordered step history
 * @property {ActionRef | null} nextAction - Next planned action (null when trail is terminal)
 * @property {number} cumulativeTokens - Tokens consumed so far on this trail
 * @property {number} cumulativeSteps - Steps executed so far
 * @property {number} [cumulativeCostCents] - Cost consumed so far in cents
 * @property {import('./routing.types.js').ForceVector | null} lastForceVector - Most recent routing force snapshot
 * @property {number} createdAt - Unix epoch ms
 * @property {number} updatedAt - Unix epoch ms
 */

/**
 * Condensed summary of a completed or in-progress step.
 *
 * @typedef {Object} TrailStepSummary
 * @property {number} index - Zero-based step index
 * @property {StepStatus} status
 * @property {ActionRef} action - The action that was executed
 * @property {string} [resultSummary] - One-line human-readable result
 * @property {number} tokensUsed - Tokens consumed by this step
 * @property {number} durationMs - Wall-clock duration
 * @property {number} timestamp - Unix epoch ms when step completed
 */

/**
 * Reference to a bound action (tool call) planned or executed by the executor.
 *
 * @typedef {Object} ActionRef
 * @property {string} toolName - Canonical tool name (e.g. 'memory.store')
 * @property {Record<string, *>} params - Resolved parameter bag
 * @property {string} [rationale] - LLM-generated reasoning for choosing this action
 */

export const TRAIL_TYPES = Symbol.for('hivemind.executor.trail.types');

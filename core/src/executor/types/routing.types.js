/**
 * Trail Executor — Routing Type Contracts
 * HIVE-MIND Cognitive Runtime
 *
 * Force-field routing: trails are selected by computing attractive
 * and repulsive forces, then picking the trail with the highest net score.
 */

/**
 * Strategy used to select the next trail to advance.
 * @typedef {'force_field' | 'round_robin' | 'priority'} TrailSelectionStrategy
 */

/**
 * Top-level routing configuration for the executor.
 *
 * @typedef {Object} RoutingConfig
 * @property {TrailSelectionStrategy} strategy - Selection algorithm
 * @property {ForceWeights} weights - Tunable multipliers for each force dimension
 * @property {number} [explorationEpsilon] - Probability of random trail pick (0-1, default: 0.05)
 * @property {number} [recomputeEveryNSteps] - Recalculate forces every N steps (default: 1)
 */

/**
 * Tunable multipliers applied to raw force dimensions before computing net score.
 *
 * @typedef {Object} ForceWeights
 * @property {number} goalAttraction - Weight for goal-proximity signal
 * @property {number} affordanceAttraction - Weight for available-action signal
 * @property {number} conflictRepulsion - Weight for conflict / contention signal
 * @property {number} congestionRepulsion - Weight for resource-congestion signal
 * @property {number} costRepulsion - Weight for budget-consumption signal
 * @property {number} [socialAttraction] - V2: weight for agent-identity affinity
 * @property {number} [momentum] - V2: weight for continuation bias
 */

/**
 * Computed force vector for a single trail at a point in time.
 *
 * @typedef {Object} ForceVector
 * @property {number} goalAttraction
 * @property {number} affordanceAttraction
 * @property {number} [socialAttraction] - V2: unlocked with agent identity
 * @property {number} [momentum] - V2: unlocked with agent identity
 * @property {number} conflictRepulsion
 * @property {number} congestionRepulsion
 * @property {number} costRepulsion
 * @property {number} net - Weighted sum (attractions minus repulsions)
 */

/**
 * Output of the routing subsystem: which trail to advance and why.
 *
 * @typedef {Object} RoutingDecision
 * @property {import('./agent.types.js').TrailId} trailId - Selected trail
 * @property {ForceVector} forceVector - Force snapshot that produced the decision
 * @property {'force_field' | 'exploration' | 'priority_override'} reason
 * @property {number} timestamp - Unix epoch ms
 */

export const ROUTING_TYPES = Symbol.for('hivemind.executor.routing.types');

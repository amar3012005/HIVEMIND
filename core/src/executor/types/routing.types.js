/**
 * Trail Executor — Routing Type Contracts
 * HIVE-MIND Cognitive Runtime
 *
 * Force-field routing: trails are selected by computing attractive
 * and repulsive forces, then picking the trail with the highest net score.
 */

/**
 * Strategy used to select the next trail to advance.
 * @typedef {'best' | 'random' | 'score_prop' | 'score_child_prop' | 'force_softmax'} TrailSelectionStrategy
 */

/**
 * Top-level routing configuration for the executor.
 *
 * @typedef {Object} RoutingConfig
 * @property {TrailSelectionStrategy} strategy - Selection algorithm
 * @property {number} temperature - Softmax temperature (higher = more exploration, lower = more exploitation)
 * @property {number} [topK] - Only consider top K candidates before softmax (default: all)
 * @property {ForceWeights} forceWeights - Tunable multipliers for each force dimension
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
 * @property {import('./agent.types.js').TrailId} selectedTrailId - Selected trail
 * @property {import('./agent.types.js').TrailId[]} candidateTrailIds - All trails considered
 * @property {ForceVector} forceVector - Force snapshot that produced the decision
 * @property {number} temperature - Softmax temperature used
 * @property {TrailSelectionStrategy} strategy - Strategy that was applied
 */

export const ROUTING_TYPES = Symbol.for('hivemind.executor.routing.types');

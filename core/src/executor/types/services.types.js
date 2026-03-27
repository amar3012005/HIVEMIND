/**
 * Trail Executor — Service Interface Type Contracts
 * HIVE-MIND Cognitive Runtime
 *
 * Input/output types and interface contracts for executor services.
 */

/**
 * Output of the trail-selection service: the chosen trail plus routing context.
 *
 * @typedef {Object} SelectedTrail
 * @property {import('./agent.types.js').TrailId} trailId
 * @property {import('./trail.types.js').Trail} trail - Full trail object
 * @property {import('./routing.types.js').RoutingDecision} decision - Routing decision that selected this trail
 */

/**
 * Input payload for updating force weights after a step completes.
 * Fed back into the routing subsystem for adaptive weight tuning.
 *
 * @typedef {Object} WeightUpdateInput
 * @property {import('./agent.types.js').TrailId} trailId
 * @property {number} stepIndex - Step that just completed
 * @property {import('./trail.types.js').StepStatus} stepStatus - Outcome of the step
 * @property {number} tokensUsed - Tokens consumed by the step
 * @property {number} durationMs - Wall-clock duration of the step
 * @property {number} [rewardSignal] - Optional scalar reward (0-1) from evaluation
 */

/**
 * TrailRouter interface — selects which trail to advance next.
 *
 * @interface TrailRouter
 *
 * @method selectTrail
 * @param {import('./trail.types.js').Trail[]} trails - Candidate trails
 * @param {import('./routing.types.js').RoutingConfig} config
 * @returns {Promise<SelectedTrail>}
 *
 * @method updateWeights
 * @param {WeightUpdateInput} input
 * @returns {Promise<void>}
 */

/**
 * TrailManager interface — CRUD and lifecycle for trails.
 *
 * @interface TrailManager
 *
 * @method createTrail
 * @param {import('./agent.types.js').GoalId} goalId
 * @param {import('./agent.types.js').NamespaceId} namespaceId
 * @param {{ priority?: number }} [options]
 * @returns {Promise<import('./trail.types.js').Trail>}
 *
 * @method getTrail
 * @param {import('./agent.types.js').TrailId} trailId
 * @returns {Promise<import('./trail.types.js').Trail | null>}
 *
 * @method updateTrailStatus
 * @param {import('./agent.types.js').TrailId} trailId
 * @param {import('./trail.types.js').TrailStatus} status
 * @returns {Promise<void>}
 *
 * @method appendStep
 * @param {import('./agent.types.js').TrailId} trailId
 * @param {import('./trail.types.js').TrailStepSummary} step
 * @returns {Promise<void>}
 */

export const SERVICES_TYPES = Symbol.for('hivemind.executor.services.types');

/**
 * Trail Executor — Force Router
 * HIVE-MIND Cognitive Runtime
 *
 * Computes Social Force Model vectors for candidate trails and selects
 * the next trail to advance via softmax sampling over net force scores.
 *
 * @module executor/force-router
 */

/** @typedef {import('./types/routing.types.js').ForceWeights} ForceWeights */
/** @typedef {import('./types/routing.types.js').ForceVector} ForceVector */
/** @typedef {import('./types/trail.types.js').Trail} Trail */

// ─── Force Computation Helpers ───────────────────────────────────────────────

/**
 * Simple word-overlap similarity between trail tags and goal keywords.
 * @param {Trail} trail
 * @param {string} goal - Goal description text
 * @returns {number} 0-1
 */
export function goalSimilarity(trail, goal) {
  const tags = trail.tags ?? [];
  if (!tags.length || !goal) return 0;

  const goalWords = goal.toLowerCase().split(/\s+/).filter(Boolean);
  if (!goalWords.length) return 0;

  const tagSet = new Set(tags.map((t) => t.toLowerCase()));
  const matches = goalWords.filter((w) => tagSet.has(w)).length;
  return matches / goalWords.length;
}

/**
 * Historical success score — already stored on the trail.
 * @param {Trail} trail
 * @returns {number} 0-1
 */
export function historicalGoalSuccess(trail) {
  return trail.successScore ?? 0;
}

/**
 * 1.0 if the trail has a concrete next action and is active, else 0.0.
 * @param {Trail} trail
 * @returns {number}
 */
export function executableNowScore(trail) {
  return trail.nextAction && trail.status === 'active' ? 1.0 : 0.0;
}

/**
 * Check how many of the next action's param template keys exist in state.
 * @param {Trail} trail
 * @param {Record<string, *>} state
 * @returns {number} 0-1
 */
export function paramBindabilityScore(trail, state) {
  const paramsTemplate = trail.nextAction?.paramsTemplate;
  if (!paramsTemplate) return 0;

  const keys = Object.keys(paramsTemplate);
  if (!keys.length) return 1.0;

  const bound = keys.filter((k) => state != null && k in state).length;
  return bound / keys.length;
}

/**
 * Low confidence = high contradiction risk.
 * @param {Trail} trail
 * @returns {number} 0-1
 */
export function contradictionRisk(trail) {
  const confidence = trail.confidence ?? 1;
  return 1.0 - confidence;
}

/**
 * Proportion of recent steps that failed.
 * @param {Trail} trail
 * @returns {number} 0-1
 */
export function recentFailureScore(trail) {
  const steps = trail.steps ?? [];
  if (!steps.length) return 0;

  const failed = steps.filter((s) => s.status === 'failed').length;
  return failed / steps.length;
}

/**
 * 1.0 if the trail is currently leased by another agent, 0.0 otherwise.
 * @param {Trail} _trail
 * @param {{ leased?: boolean }} [leaseInfo]
 * @returns {number}
 */
export function activeLeasePressure(_trail, leaseInfo) {
  return leaseInfo?.leased ? 1.0 : 0.0;
}

/**
 * Normalize queue depth to 0-1 range (caps at 10).
 * @param {Trail} _trail
 * @param {{ depth?: number }} [queueInfo]
 * @returns {number}
 */
export function queueDepthPressure(_trail, queueInfo) {
  const depth = queueInfo?.depth ?? 0;
  return Math.min(depth / 10, 1.0);
}

/**
 * Placeholder token cost estimate (V1).
 * @param {Trail} _trail
 * @returns {number}
 */
export function estimatedTokenCost(_trail) {
  return 0.1;
}

/**
 * Placeholder latency cost estimate (V1).
 * @param {Trail} _trail
 * @returns {number}
 */
export function estimatedLatencyCost(_trail) {
  return 0.1;
}

/**
 * Penalize trails that appear in recent history.
 * Immediate repeat = 1.0, decays with distance.
 * @param {Trail} trail
 * @param {string[]} recentTrailHistory - recent trail IDs (most recent last)
 * @returns {number} 0-1
 */
export function recentReusePenalty(trail, recentTrailHistory) {
  if (!recentTrailHistory?.length) return 0;
  const reversed = [...recentTrailHistory].reverse();
  const idx = reversed.indexOf(trail.id);
  if (idx === -1) return 0;
  // Immediate reuse = 1.0, one step ago = 0.7, two = 0.5, three = 0.3
  return Math.max(0, 1.0 - (idx * 0.3));
}

/**
 * Social attraction: prefer trails created/used by high-reputation agents.
 * Capped at 0.25 to prevent runaway prestige effects.
 * @param {Trail} trail
 * @param {{ agentScores?: Record<string, { success_rate: number }> }} [reputationContext]
 * @returns {number} 0-0.25
 */
export function trustedAgentUsage(trail, reputationContext) {
  if (!reputationContext?.agentScores) return 0;
  const creatorRep = reputationContext.agentScores[trail.agentId];
  if (!creatorRep) return 0;
  return Math.min(creatorRep.success_rate * 0.5, 0.25);
}

/**
 * Momentum: prefer trails that continue the agent's current productive path.
 * Same trail = 0.8, same family = 0.3, unrelated = 0.
 * @param {Trail} trail
 * @param {string[]} recentTrailHistory
 * @param {string} [trailFamilyKey]
 * @returns {number}
 */
export function pathContinuityScore(trail, recentTrailHistory, trailFamilyKey) {
  if (!recentTrailHistory?.length) return 0;
  const lastTrailId = recentTrailHistory[recentTrailHistory.length - 1];
  if (trail.id === lastTrailId) return 0.8;
  if (trailFamilyKey) {
    const trailKey = trail.blueprintMeta?.chainSignature || trail.nextAction?.tool || '';
    if (trailKey && trailKey === trailFamilyKey) return 0.3;
  }
  return 0;
}

// ─── ForceRouter ─────────────────────────────────────────────────────────────

/** @type {ForceWeights} */
const DEFAULT_WEIGHTS = {
  goalAttraction: 1.0,
  affordanceAttraction: 1.0,
  conflictRepulsion: 1.0,
  congestionRepulsion: 1.0,
  costRepulsion: 1.0,
};

export class ForceRouter {
  /** @param {{ forceWeights?: ForceWeights }} [config] */
  constructor(config = {}) {
    this.weights = { ...DEFAULT_WEIGHTS, ...config.forceWeights };
  }

  /**
   * Compute the force vector for a single candidate trail.
   *
   * @param {Trail} trail
   * @param {{ goal?: string, state?: Record<string, *>, leaseInfo?: { leased?: boolean }, queueInfo?: { depth?: number }, recentTrailHistory?: string[] }} context
   * @returns {ForceVector}
   */
  computeForces(trail, context = {}) {
    const { goal = '', state = {}, leaseInfo, queueInfo, recentTrailHistory, reputationContext, trailFamilyKey } = context;
    const w = this.weights;

    const goalAttr =
      w.goalAttraction * (goalSimilarity(trail, goal) + historicalGoalSuccess(trail));
    const affordanceAttr =
      w.affordanceAttraction * (executableNowScore(trail) + paramBindabilityScore(trail, state));
    const conflictRep =
      w.conflictRepulsion * (contradictionRisk(trail) + recentFailureScore(trail));
    const congestionRep =
      w.congestionRepulsion * (activeLeasePressure(trail, leaseInfo) + queueDepthPressure(trail, queueInfo) + recentReusePenalty(trail, recentTrailHistory));
    const costRep =
      w.costRepulsion * (estimatedTokenCost(trail) + estimatedLatencyCost(trail));

    const blueprintBoost =
      (trail.kind === 'blueprint' && trail.blueprintMeta?.state === 'active')
        ? (w.blueprintPrior ?? 0) : 0;

    const social = (w.social ?? 0) * trustedAgentUsage(trail, reputationContext);
    const mom = (w.momentum ?? 0) * pathContinuityScore(trail, recentTrailHistory, trailFamilyKey);

    const net = goalAttr + affordanceAttr + blueprintBoost + social + mom - conflictRep - congestionRep - costRep;

    return {
      goalAttraction: goalAttr,
      affordanceAttraction: affordanceAttr,
      blueprintBoost,
      socialAttraction: social,
      momentum: mom,
      conflictRepulsion: conflictRep,
      congestionRepulsion: congestionRep,
      costRepulsion: costRep,
      net,
    };
  }

  /**
   * Apply softmax sampling over candidate net forces with temperature.
   * Returns the probabilistically selected candidate (NOT argmax).
   *
   * @param {{ trail: Trail, forces: ForceVector }[]} candidates
   * @param {number} [temperature=1.0]
   * @returns {{ trail: Trail, forces: ForceVector } | null}
   */
  softmaxSample(candidates, temperature = 1.0) {
    if (!candidates.length) return null;
    if (candidates.length === 1) return candidates[0];

    const t = Math.max(temperature, 1e-8); // avoid division by zero

    // Compute logits scaled by temperature
    const logits = candidates.map((c) => c.forces.net / t);

    // Numerical stability: subtract max logit
    const maxLogit = Math.max(...logits);
    const expValues = logits.map((l) => Math.exp(l - maxLogit));
    const sumExp = expValues.reduce((a, b) => a + b, 0);

    // Build CDF and sample
    const rand = Math.random();
    let cumulative = 0;
    for (let i = 0; i < candidates.length; i++) {
      cumulative += expValues[i] / sumExp;
      if (rand <= cumulative) return candidates[i];
    }

    // Fallback (floating-point edge case)
    return candidates[candidates.length - 1];
  }
}

export default ForceRouter;

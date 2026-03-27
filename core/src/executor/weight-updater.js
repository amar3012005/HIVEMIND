/**
 * Trail Executor — Weight Updater
 * HIVE-MIND Cognitive Runtime
 *
 * Computes multi-signal trail weights from confidence, failure history,
 * agent reputation, novelty, downstream success, and cost signals.
 * Stores weight components alongside the final score for explainability.
 *
 * @module executor/weight-updater
 */

export class WeightUpdater {
  /** @param {{ updateTrailWeight: Function }} store */
  constructor(store) {
    this.store = store;
  }

  /**
   * Compute and persist multi-signal trail weight.
   *
   * @param {Object} params
   * @param {Object} params.trail - Trail object (must have .id)
   * @param {number} params.confidence - Base confidence score (0-1)
   * @param {number} [params.latencyMs]
   * @param {number} [params.tokensUsed]
   * @param {number} [params.estimatedCostUsd]
   * @param {number} [params.recentFailureCount]
   * @param {number} [params.agentReputation]
   * @param {number} [params.noveltyPenalty]
   * @param {number} [params.downstreamSuccessFactor]
   * @returns {Promise<number>} Final clamped weight
   */
  async update(params) {
    const {
      trail,
      confidence,
      recentFailureCount = 0,
      agentReputation,
      noveltyPenalty,
      downstreamSuccessFactor,
      estimatedCostUsd,
    } = params;

    // Base confidence (0-1)
    const base_confidence = confidence;

    // Recent failure penalty: (count / 10) * 0.5, clamped [0, 0.5]
    const failure_penalty = Math.min((recentFailureCount / 10) * 0.5, 0.5);

    // Agent reputation boost: reputation * 0.3 (default reputation 0.5)
    const agent_reputation_boost = (agentReputation ?? 0.5) * 0.3;

    // Novelty discount (0.1 if novel, else 0)
    const novelty_discount = noveltyPenalty ?? 0;

    // Downstream success factor boost * 0.2
    const downstream_success_factor = (downstreamSuccessFactor ?? 0) * 0.2;

    // Cost factor: 1 - min(cost / 1.0, 0.3)
    const cost_factor = 1 - Math.min((estimatedCostUsd ?? 0) / 1.0, 0.3);

    // Composite weight
    const trailWeight =
      base_confidence *
      (1 - failure_penalty) *
      (1 + agent_reputation_boost) *
      (1 - novelty_discount) *
      (1 + downstream_success_factor);

    const finalWeight = Math.min(Math.max(trailWeight * cost_factor, 0), 1);

    const components = {
      base_confidence,
      failure_penalty,
      agent_reputation_boost,
      novelty_discount,
      downstream_success_factor,
      cost_factor,
    };

    await this.store.updateTrailWeight(trail.id, finalWeight, components);
    return finalWeight;
  }
}

export default WeightUpdater;

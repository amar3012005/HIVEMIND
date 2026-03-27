/**
 * Trail Executor — Promotion Mux
 * HIVE-MIND Cognitive Runtime
 *
 * Emits promotion candidates asynchronously with idempotency
 * guarantees via dedupe keys derived from event + rule + goal.
 *
 * @module executor/promotion-mux
 */

import { randomUUID } from 'node:crypto';

export class PromotionMux {
  /** @param {{ emitPromotionCandidate: Function }} store */
  constructor(store) {
    this.store = store;
  }

  /**
   * Emit a promotion candidate for a trail, deduplicating by event + rule + goal.
   *
   * @param {Object} event - Execution event (must have .id)
   * @param {Object} trail - Trail object (must have .id and .goalId)
   * @param {number} confidence - Confidence score for promotion
   * @param {string} promotionRuleId - Rule that triggered promotion
   * @param {Array} observations - Array of Observation objects
   * @returns {Promise<Object|null>} The candidate, or null if deduplicated
   */
  async emitCandidate(event, trail, confidence, promotionRuleId, observations) {
    const dedupeKey = `${event.id}:${promotionRuleId}:${trail.goalId}`;

    const candidate = {
      id: randomUUID(),
      source_event_id: event.id,
      trail_id: trail.id,
      promotion_rule_id: promotionRuleId,
      observations: observations ?? [],
      confidence,
      status: 'pending',
      dedupe_key: dedupeKey,
      created_at: new Date().toISOString(),
    };

    const result = await this.store.emitPromotionCandidate(candidate);
    return result;
  }
}

export default PromotionMux;

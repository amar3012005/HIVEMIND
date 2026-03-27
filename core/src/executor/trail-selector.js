/**
 * Trail Executor — Trail Selector
 * HIVE-MIND Cognitive Runtime
 *
 * Orchestrates candidate retrieval, filtering, force computation,
 * and softmax sampling to produce a routing decision.
 *
 * @module executor/trail-selector
 */

/** @typedef {import('./types/routing.types.js').RoutingConfig} RoutingConfig */
/** @typedef {import('./types/routing.types.js').RoutingDecision} RoutingDecision */
/** @typedef {import('./types/services.types.js').SelectedTrail} SelectedTrail */
/** @typedef {import('./types/trail.types.js').Trail} Trail */

import { ForceRouter } from './force-router.js';

export class TrailSelector {
  /**
   * @param {object} graphStore  - Store with getCandidateTrails(goalId, namespaceId)
   * @param {object} leaseManager - Manager with getLeaseInfo(trailId)
   * @param {ForceRouter} forceRouter
   */
  constructor(graphStore, leaseManager, forceRouter) {
    this.graphStore = graphStore;
    this.leaseManager = leaseManager;
    this.forceRouter = forceRouter;
  }

  /**
   * Select the next trail to advance.
   *
   * @param {string} goal - Goal description text
   * @param {{ goalId: string, namespaceId: string, state?: Record<string, *>, queueInfo?: { depth?: number }, recentTrailHistory?: string[] }} context
   * @param {string} agentId
   * @param {RoutingConfig} routingConfig
   * @returns {Promise<SelectedTrail | null>}
   */
  async selectNext(goal, context, agentId, routingConfig) {
    const { goalId, namespaceId, state = {}, queueInfo, recentTrailHistory } = context;
    const temperature = routingConfig.temperature ?? 1.0;

    // 1. Get candidate trails from graphStore
    const allTrails = await this.graphStore.getCandidateTrails(goalId, namespaceId);
    if (!allTrails || !allTrails.length) return null;

    // 2. Filter by status === 'active'
    const activeTrails = allTrails.filter((t) => t.status === 'active');
    if (!activeTrails.length) return null;

    // 3. Compute force vector for each candidate (with reuse penalty)
    const candidates = await Promise.all(
      activeTrails.map(async (trail) => {
        const leaseInfo = this.leaseManager
          ? await this.leaseManager.getLeaseInfo(trail.id)
          : { leased: false };

        const forces = this.forceRouter.computeForces(trail, {
          goal,
          state,
          leaseInfo,
          queueInfo,
          recentTrailHistory,
        });

        return { trail, forces };
      }),
    );

    // 4. Apply softmax sampling with temperature
    const selected = this.forceRouter.softmaxSample(candidates, temperature);
    if (!selected) return null;

    // 5. Build routing decision
    /** @type {RoutingDecision} */
    const decision = {
      selectedTrailId: selected.trail.id,
      candidateTrailIds: activeTrails.map((t) => t.id),
      forceVector: selected.forces,
      temperature,
      strategy: routingConfig.strategy ?? 'force_softmax',
    };

    return {
      trailId: selected.trail.id,
      trail: selected.trail,
      decision,
    };
  }
}

export default TrailSelector;

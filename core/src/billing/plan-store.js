/**
 * Plan Store
 *
 * Stores the active plan for each organization.
 * Uses the Organization.plan column as the source of truth and
 * falls back to legacy metadata.planId if present.
 */

import { getPlan } from './plans.js';
import { getEffectivePlan } from './entitlements.js';

export class PlanStore {
  constructor(prisma) {
    this.prisma = prisma;
    this._cache = new Map();
  }

  /**
   * Get the active plan for an org.
   * Defaults to 'free' if not set.
   */
  async getOrgPlan(orgId) {
    if (!this.prisma || !orgId) return getPlan('free');

    const cached = this._cache.get(orgId);
    if (cached && Date.now() < cached.expiresAt) return cached.plan;

    try {
      const { plan, entitlement } = await getEffectivePlan(this.prisma, orgId);
      const transitionAt = entitlement?.effectiveUntil ? new Date(entitlement.effectiveUntil).getTime() : Infinity;
      // Entitlements can be changed by a Stripe webhook in another process;
      // keep their cache short while ordinary fallback plans remain cheap.
      const ttl = entitlement ? 30_000 : 300_000;
      this._cache.set(orgId, { plan, expiresAt: Math.min(Date.now() + ttl, transitionAt) });
      return plan;
    } catch {
      return getPlan('free');
    }
  }

  /**
   * Set the plan for an org.
   */
  async setOrgPlan(orgId, planId) {
    if (!this.prisma || !orgId) return;
    const plan = getPlan(planId);
    try {
      await this.prisma.organization.update({
        where: { id: orgId },
        data: { plan: plan.id },
      });
      this._cache.set(orgId, { plan, ts: Date.now() });
    } catch (err) {
      console.warn('[plan-store] Set plan failed:', err.message);
    }
  }

  invalidate(orgId) {
    this._cache.delete(orgId);
  }
}

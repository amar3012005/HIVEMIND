/**
 * Plan Store
 *
 * Stores the active plan for each organization.
 * Uses the Organization's metadata JSON field.
 */

import { getPlan } from './plans.js';

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
    if (cached && Date.now() - cached.ts < 300_000) return cached.plan;

    try {
      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { metadata: true },
      });
      const planId = (org?.metadata && typeof org.metadata === 'object') ? org.metadata.planId : 'free';
      const plan = getPlan(planId || 'free');
      this._cache.set(orgId, { plan, ts: Date.now() });
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
      const org = await this.prisma.organization.findUnique({
        where: { id: orgId },
        select: { metadata: true },
      });
      const existing = (org?.metadata && typeof org.metadata === 'object') ? org.metadata : {};
      await this.prisma.organization.update({
        where: { id: orgId },
        data: { metadata: { ...existing, planId: plan.id, planUpdatedAt: new Date().toISOString() } },
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

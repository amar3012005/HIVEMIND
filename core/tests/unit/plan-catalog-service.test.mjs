import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  createCatalogPlanVersion,
  listCatalogPlanHistory,
  resolveCatalogPlan,
} from '../../src/billing/plan-catalog-service.js';
import { mergeEntitlementPlan } from '../../src/billing/entitlements.js';

function catalogPrisma() {
  const rows = [];
  const model = {
    findFirst: async ({ where }) => rows.filter((row) => row.planId === where.planId).sort((a, b) => b.version - a.version)[0] || null,
    findMany: async ({ where, take } = {}) => rows.filter((row) => !where || row.planId === where.planId).sort((a, b) => b.version - a.version).slice(0, take || rows.length),
    create: async ({ data }) => {
      const row = { id: `version-${rows.length + 1}`, createdAt: new Date('2026-08-03T00:00:00.000Z'), ...data };
      rows.push(row);
      return row;
    },
  };
  return { planCatalogVersion: model, $transaction: async (fn) => fn({ planCatalogVersion: model }) };
}

describe('versioned plan catalog', () => {
  it('applies a global cap as an immutable full snapshot', async () => {
    const prisma = catalogPrisma();
    const updated = await createCatalogPlanVersion({
      prisma, planId: 'pro', action: 'apply', limits: { maxUsers: 12 }, operator: 'operator', requestId: 'request-1',
    });
    assert.equal(updated.limits.maxUsers, 12);
    assert.equal(updated.limits.llmTokensPerMonth, 10_000_000);
    assert.equal(updated.catalogVersion.version, 1);
    assert.equal((await resolveCatalogPlan(prisma, 'pro')).limits.maxUsers, 12);
  });

  it('records default restore as a new version instead of deleting history', async () => {
    const prisma = catalogPrisma();
    await createCatalogPlanVersion({ prisma, planId: 'free', action: 'apply', limits: { maxMemories: 42 }, operator: 'operator' });
    const restored = await createCatalogPlanVersion({ prisma, planId: 'free', action: 'restore_default', operator: 'operator' });
    assert.equal(restored.limits.maxMemories, 1_000);
    const history = await listCatalogPlanHistory(prisma, 'free');
    assert.deepEqual(history.map((row) => row.action), ['restore_default', 'apply']);
  });

  it('layers a specific grant over the current catalog cap', async () => {
    const prisma = catalogPrisma();
    await createCatalogPlanVersion({ prisma, planId: 'scale', action: 'apply', limits: { maxUsers: 40 }, operator: 'operator' });
    const catalogPlan = await resolveCatalogPlan(prisma, 'scale');
    const entitled = mergeEntitlementPlan('scale', { maxUsers: 7 }, catalogPlan);
    assert.equal(entitled.limits.maxUsers, 7);
    assert.equal(entitled.limits.webIntelPerDay, 500);
  });
});

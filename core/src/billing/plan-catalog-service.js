import { getAllPlans, getPlan } from './plans.js';

const PLAN_IDS = new Set(getAllPlans().map((plan) => plan.id));

function validLimit(plan, key, value) {
  if (!Object.prototype.hasOwnProperty.call(plan.limits, key)) return false;
  return Number.isSafeInteger(value) && value >= -1;
}

export function normalizePlanCatalogLimits(planId, limits) {
  const plan = getPlan(planId);
  if (!PLAN_IDS.has(plan.id) || !limits || typeof limits !== 'object' || Array.isArray(limits)) {
    return null;
  }
  const normalized = {};
  for (const [key, raw] of Object.entries(limits)) {
    if (typeof raw === 'string' && raw.trim() === '') throw new Error(`invalid limit: ${key}`);
    const value = Number(raw);
    if (!validLimit(plan, key, value)) throw new Error(`invalid limit: ${key}`);
    normalized[key] = value;
  }
  return normalized;
}

function materialize(planId, limits, version = null) {
  const base = getPlan(planId);
  return {
    ...base,
    limits: { ...base.limits, ...(limits || {}) },
    catalogVersion: version ? {
      id: version.id,
      version: version.version,
      action: version.action,
      createdAt: version.createdAt,
    } : null,
  };
}

async function latest(prisma, planId) {
  if (!prisma?.planCatalogVersion) return null;
  return prisma.planCatalogVersion.findFirst({
    where: { planId },
    orderBy: { version: 'desc' },
  });
}

/** Resolve the plan used at runtime. Defaults in plans.js remain immutable and
 * a catalog row is a versioned platform-wide cap overlay. */
export async function resolveCatalogPlan(prisma, planId) {
  const id = PLAN_IDS.has(String(planId || '').toLowerCase()) ? String(planId).toLowerCase() : 'free';
  const row = await latest(prisma, id);
  return materialize(id, row?.limits, row);
}

export async function listCatalogPlans(prisma) {
  const rows = prisma?.planCatalogVersion
    ? await prisma.planCatalogVersion.findMany({ orderBy: [{ planId: 'asc' }, { version: 'desc' }] })
    : [];
  const latestByPlan = new Map();
  for (const row of rows) if (!latestByPlan.has(row.planId)) latestByPlan.set(row.planId, row);
  return getAllPlans().map((plan) => materialize(plan.id, latestByPlan.get(plan.id)?.limits, latestByPlan.get(plan.id)));
}

/** Each apply/default action writes a full snapshot. Older effective caps are
 * never mutated, so operators can inspect the exact historical catalog. */
export async function createCatalogPlanVersion({ prisma, planId, limits, action, operator, requestId = null }) {
  const id = String(planId || '').toLowerCase();
  if (!PLAN_IDS.has(id)) throw new Error('invalid plan');
  if (!['apply', 'restore_default'].includes(action)) throw new Error('invalid catalog action');
  const requested = action === 'restore_default' ? {} : normalizePlanCatalogLimits(id, limits);
  if (requested == null) throw new Error('limits are required');
  return prisma.$transaction(async (tx) => {
    const previous = await latest(tx, id);
    const prior = previous?.limits || getPlan(id).limits;
    const snapshot = action === 'restore_default' ? { ...getPlan(id).limits } : { ...prior, ...requested };
    const row = await tx.planCatalogVersion.create({ data: {
      planId: id,
      version: (previous?.version || 0) + 1,
      limits: snapshot,
      action,
      operator: String(operator || 'platform_admin').slice(0, 160),
      requestId: requestId ? String(requestId).slice(0, 128) : null,
    } });
    return materialize(id, row.limits, row);
  });
}

export async function listCatalogPlanHistory(prisma, planId, take = 30) {
  const id = String(planId || '').toLowerCase();
  if (!PLAN_IDS.has(id)) throw new Error('invalid plan');
  return prisma.planCatalogVersion.findMany({ where: { planId: id }, orderBy: { version: 'desc' }, take: Math.min(100, Math.max(1, take)) });
}

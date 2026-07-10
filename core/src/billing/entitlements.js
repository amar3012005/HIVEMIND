import { getPlan } from './plans.js';

export function normalizeReferralCode(value) {
  return String(value || '').trim().toUpperCase();
}

export function mergeEntitlementPlan(planId, limits) {
  const base = getPlan(planId);
  const overrides = normalizeLimitOverrides(planId, limits);
  return { ...base, limits: { ...base.limits, ...overrides } };
}

export function normalizeLimitOverrides(planId, limits) {
  const base = getPlan(planId);
  if (!limits || typeof limits !== 'object' || Array.isArray(limits)) return {};
  const normalized = {};
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.prototype.hasOwnProperty.call(base.limits, key)) continue;
    const number = Number(value);
    if (!Number.isSafeInteger(number) || number < -1) continue;
    normalized[key] = number;
  }
  return normalized;
}

export function buildStandardOffer(planId, now = new Date()) {
  const plan = getPlan(planId);
  const onboardingDays = Math.max(0, Number(plan.commercial?.onboardingDays) || 0);
  return {
    kind: 'standard',
    target_plan: plan.id,
    onboarding_days: onboardingDays,
    onboarding_plan: plan.id,
    onboarding_limits: {},
    runway_plan: plan.id,
    runway_limits: {},
    onboarding_price: plan.commercial?.onboardingPrice ?? null,
    currency: plan.currency,
    quoted_at: now.toISOString(),
  };
}

export function buildReferralOffer(campaign, now = new Date()) {
  return {
    kind: 'referral',
    campaign_id: campaign.id,
    code: campaign.code,
    onboarding_days: campaign.onboardingDays,
    onboarding_plan: campaign.onboardingPlan,
    onboarding_limits: normalizeLimitOverrides(campaign.onboardingPlan, campaign.onboardingLimits),
    runway_plan: campaign.runwayPlan,
    runway_limits: normalizeLimitOverrides(campaign.runwayPlan, campaign.runwayLimits),
    quoted_at: now.toISOString(),
  };
}

export async function activateOffer({ tx, orgId, offer, source, now = new Date() }) {
  const onboardingPlan = String(offer?.onboarding_plan || offer?.target_plan || 'free');
  const runwayPlan = String(offer?.runway_plan || offer?.target_plan || onboardingPlan);
  const onboardingDays = Math.max(0, Math.min(90, Number(offer?.onboarding_days) || 0));
  const onboardingLimits = normalizeLimitOverrides(onboardingPlan, offer?.onboarding_limits);
  const runwayLimits = normalizeLimitOverrides(runwayPlan, offer?.runway_limits);
  const runwayStartsAt = new Date(now.getTime() + onboardingDays * 24 * 60 * 60 * 1000);
  await tx.organizationEntitlement.deleteMany({ where: { orgId, effectiveFrom: { gt: now } } });
  await tx.organizationEntitlement.updateMany({
    where: {
      orgId,
      effectiveFrom: { lte: now },
      OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }],
    },
    data: { effectiveUntil: now },
  });
  const rows = onboardingDays > 0 ? [
    { orgId, source, phase: 'onboarding', planId: onboardingPlan, limits: onboardingLimits, effectiveFrom: now, effectiveUntil: runwayStartsAt },
    { orgId, source, phase: 'runway', planId: runwayPlan, limits: runwayLimits, effectiveFrom: runwayStartsAt },
  ] : [
    { orgId, source, phase: 'runway', planId: runwayPlan, limits: runwayLimits, effectiveFrom: now },
  ];
  await tx.organizationEntitlement.createMany({ data: rows });
  await tx.organization.update({
    where: { id: orgId },
    data: {
      plan: onboardingDays > 0 ? onboardingPlan : runwayPlan,
      subscriptionStatus: 'active',
      trialEndsAt: onboardingDays > 0 ? runwayStartsAt : null,
    },
  });
  return { runwayStartsAt, onboardingPlan, runwayPlan };
}

export async function getEffectiveEntitlement(prisma, orgId, now = new Date()) {
  if (!prisma?.organizationEntitlement || !orgId) return null;
  return prisma.organizationEntitlement.findFirst({
    where: { orgId, effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] },
    orderBy: { effectiveFrom: 'desc' },
  });
}

export async function getEffectivePlan(prisma, orgId) {
  const fallback = await prisma.organization.findUnique({ where: { id: orgId }, select: { plan: true } });
  const entitlement = await getEffectiveEntitlement(prisma, orgId);
  if (!entitlement) return { plan: getPlan(fallback?.plan || 'free'), entitlement: null };
  return { plan: mergeEntitlementPlan(entitlement.planId, entitlement.limits), entitlement };
}

export async function claimReferralOffer({ tx, orgId, userId, offer, now = new Date() }) {
  const existing = await tx.referralRedemption.findUnique({ where: { orgId } });
  if (existing) throw new Error('a referral has already been redeemed for this organization');
  const campaign = await tx.referralCampaign.findUnique({ where: { id: offer?.campaign_id } });
  if (!campaign || campaign.code !== offer?.code || !campaign.active
    || (campaign.startsAt && campaign.startsAt > now)
    || (campaign.endsAt && campaign.endsAt <= now)) {
    throw new Error('invalid or inactive referral code');
  }
  const claimed = await tx.referralCampaign.updateMany({
    where: {
      id: campaign.id,
      active: true,
      ...(campaign.maxRedemptions == null ? {} : { redemptionCount: { lt: campaign.maxRedemptions } }),
    },
    data: { redemptionCount: { increment: 1 } },
  });
  if (claimed.count !== 1) throw new Error('referral code redemption limit reached');
  const activation = await activateOffer({ tx, orgId, offer, source: 'referral', now });
  const redemption = await tx.referralRedemption.create({
    data: {
      campaignId: campaign.id,
      orgId,
      redeemedByUserId: userId,
      codeSnapshot: campaign.code,
      termsSnapshot: offer,
    },
  });
  return { redemption, terms: offer, ...activation };
}

export async function redeemReferral({ prisma, orgId, userId, code }) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) throw new Error('referral code required');
  return prisma.$transaction(async (tx) => {
    const campaign = await tx.referralCampaign.findUnique({ where: { code: normalized } });
    const now = new Date();
    if (!campaign || !campaign.active || (campaign.startsAt && campaign.startsAt > now) || (campaign.endsAt && campaign.endsAt <= now)) {
      throw new Error('invalid or inactive referral code');
    }
    return claimReferralOffer({ tx, orgId, userId, offer: buildReferralOffer(campaign, now), now });
  });
}

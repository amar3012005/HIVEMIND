import { getPlan } from './plans.js';

export function normalizeReferralCode(value) {
  return String(value || '').trim().toUpperCase();
}

export function mergeEntitlementPlan(planId, limits) {
  const base = getPlan(planId);
  const overrides = limits && typeof limits === 'object' && !Array.isArray(limits) ? limits : {};
  return { ...base, limits: { ...base.limits, ...overrides } };
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

export async function redeemReferral({ prisma, orgId, userId, code }) {
  const normalized = normalizeReferralCode(code);
  if (!normalized) throw new Error('referral code required');
  return prisma.$transaction(async (tx) => {
    const existing = await tx.referralRedemption.findUnique({ where: { orgId } });
    if (existing) throw new Error('a referral has already been redeemed for this organization');
    const campaign = await tx.referralCampaign.findUnique({ where: { code: normalized } });
    const now = new Date();
    if (!campaign || !campaign.active || (campaign.startsAt && campaign.startsAt > now) || (campaign.endsAt && campaign.endsAt <= now)) {
      throw new Error('invalid or inactive referral code');
    }
    const claimed = await tx.referralCampaign.updateMany({
      where: { id: campaign.id, active: true, ...(campaign.maxRedemptions == null ? {} : { redemptionCount: { lt: campaign.maxRedemptions } }) },
      data: { redemptionCount: { increment: 1 } },
    });
    if (claimed.count !== 1) throw new Error('referral code redemption limit reached');
    const runwayStartsAt = new Date(now.getTime() + campaign.onboardingDays * 24 * 60 * 60 * 1000);
    const terms = {
      code: campaign.code, onboarding_days: campaign.onboardingDays,
      onboarding_plan: campaign.onboardingPlan, onboarding_limits: campaign.onboardingLimits,
      runway_plan: campaign.runwayPlan, runway_limits: campaign.runwayLimits,
    };
    await tx.organizationEntitlement.createMany({ data: [
      { orgId, source: 'referral', phase: 'onboarding', planId: campaign.onboardingPlan, limits: campaign.onboardingLimits, effectiveFrom: now, effectiveUntil: runwayStartsAt },
      { orgId, source: 'referral', phase: 'runway', planId: campaign.runwayPlan, limits: campaign.runwayLimits, effectiveFrom: runwayStartsAt },
    ] });
    const redemption = await tx.referralRedemption.create({ data: { campaignId: campaign.id, orgId, redeemedByUserId: userId, codeSnapshot: campaign.code, termsSnapshot: terms } });
    await tx.organization.update({ where: { id: orgId }, data: { plan: campaign.onboardingPlan, trialEndsAt: runwayStartsAt } });
    return { redemption, terms, runwayStartsAt };
  });
}

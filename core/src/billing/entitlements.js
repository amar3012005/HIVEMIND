import { getPlan } from './plans.js';
import { resolveCatalogPlan } from './plan-catalog-service.js';

export function normalizeReferralCode(value) {
  return String(value || '').trim().toUpperCase();
}

export function mergeEntitlementPlan(planId, limits, basePlan = null) {
  const base = basePlan || getPlan(planId);
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
    runway_interval_months: Math.max(1, Number(campaign.runwayIntervalMonths) || 1),
    discount: buildReferralDiscount(campaign),
    quoted_at: now.toISOString(),
  };
}

/// Each code carries at most one discount shape: a percentage off, or a fixed
/// amount off (in minor currency units). 'none' means no billing discount —
/// the code only configures onboarding/runway entitlement phasing.
export function buildReferralDiscount(campaign) {
  const kind = String(campaign?.discountKind || 'none');
  if (kind === 'percentage') {
    const percent = Number(campaign.discountPercent);
    if (!Number.isFinite(percent) || percent <= 0 || percent > 100) return { kind: 'none' };
    return { kind: 'percentage', percent_off: percent };
  }
  if (kind === 'fixed') {
    const amountCents = Number(campaign.discountAmountCents);
    if (!Number.isFinite(amountCents) || amountCents <= 0) return { kind: 'none' };
    return { kind: 'fixed', amount_off_cents: amountCents, currency: String(campaign.discountCurrency || 'EUR').toUpperCase() };
  }
  return { kind: 'none' };
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
  const fallbackPlanId = fallback?.plan || 'free';
  // Promotions are the authoritative commercial overlay. Keep the legacy
  // time-row resolver beneath this branch while existing referrals migrate.
  const { getEffectivePromotionEntitlement } = await import('./promotion-service.js');
  const promotion = await getEffectivePromotionEntitlement(prisma, orgId);
  if (promotion?.status === 'active' && promotion.version) {
    const basePlan = await resolveCatalogPlan(prisma, promotion.version.planId);
    return {
      plan: mergeEntitlementPlan(promotion.version.planId, promotion.version.limits, basePlan),
      entitlement: {
        id: promotion.grant.id,
        source: promotion.grant.source,
        phase: 'promotion',
        planId: promotion.version.planId,
        limits: promotion.version.limits,
        effectiveFrom: promotion.version.effectiveFrom,
        effectiveUntil: promotion.grant.endsAt,
        status: promotion.status,
        grantId: promotion.grant.id,
        accountType: promotion.version.accountType,
        hostingMode: promotion.version.hostingMode,
        storageMode: promotion.version.storageMode,
      },
    };
  }
  if (promotion && ['manual_review', 'expired', 'suspended', 'revoked'].includes(promotion.status)) {
    return {
      plan: await resolveCatalogPlan(prisma, 'free'),
      entitlement: {
        id: promotion.grant.id,
        source: promotion.grant.source,
        phase: promotion.status,
        planId: 'free', limits: {}, effectiveFrom: promotion.grant.startsAt,
        effectiveUntil: promotion.grant.endsAt, status: promotion.status, grantId: promotion.grant.id,
      },
    };
  }
  const entitlement = await getEffectiveEntitlement(prisma, orgId);
  if (!entitlement) return { plan: await resolveCatalogPlan(prisma, fallbackPlanId), entitlement: null };
  const basePlan = await resolveCatalogPlan(prisma, entitlement.planId);
  return { plan: mergeEntitlementPlan(entitlement.planId, entitlement.limits, basePlan), entitlement };
}

// Canonical commercial read used by Billing, Usage, feature admission, and
// external adapters. The legacy name remains for compatibility.
export async function resolveEffectiveEntitlement(prisma, orgId) {
  return getEffectivePlan(prisma, orgId);
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

/// Validates/shapes an admin-submitted create payload for a two-phase
/// (onboarding + runway) referral campaign. Throws with a field-named message
/// on anything invalid rather than silently coercing bad input.
export function normalizeReferralCampaignInput(input = {}) {
  const code = normalizeReferralCode(input.code);
  if (!code) throw new Error('code is required');
  const name = String(input.name || '').trim().slice(0, 160);
  if (!name) throw new Error('name is required');

  const onboardingDays = input.onboarding_days === undefined || input.onboarding_days === null || input.onboarding_days === ''
    ? 14
    : Number(input.onboarding_days);
  if (!Number.isFinite(onboardingDays) || onboardingDays < 0 || onboardingDays > 90) {
    throw new Error('onboarding_days must be between 0 and 90 (default 14)');
  }

  const runwayIntervalMonths = input.runway_interval_months === undefined || input.runway_interval_months === null || input.runway_interval_months === ''
    ? 1
    : Number(input.runway_interval_months);
  if (!Number.isInteger(runwayIntervalMonths) || runwayIntervalMonths < 1 || runwayIntervalMonths > 12) {
    throw new Error('runway_interval_months must be an integer between 1 and 12 (default 1 = monthly)');
  }

  const onboardingPlan = String(input.onboarding_plan || 'enterprise').trim() || 'enterprise';
  const runwayPlan = String(input.runway_plan || 'enterprise').trim() || 'enterprise';

  const discountKind = String(input.discount_kind || 'none').trim().toLowerCase();
  if (!['none', 'percentage', 'fixed'].includes(discountKind)) {
    throw new Error("discount_kind must be one of 'none', 'percentage', 'fixed'");
  }
  let discountPercent = null;
  let discountAmountCents = null;
  let discountCurrency = String(input.discount_currency || 'EUR').trim().toUpperCase().slice(0, 3) || 'EUR';
  if (discountKind === 'percentage') {
    discountPercent = Number(input.discount_percent);
    if (!Number.isFinite(discountPercent) || discountPercent <= 0 || discountPercent > 100) {
      throw new Error('discount_percent must be between 1 and 100');
    }
    discountPercent = Math.round(discountPercent);
  } else if (discountKind === 'fixed') {
    discountAmountCents = Number(input.discount_amount_cents);
    if (!Number.isFinite(discountAmountCents) || discountAmountCents <= 0) {
      throw new Error('discount_amount_cents must be a positive integer (minor currency units)');
    }
    discountAmountCents = Math.round(discountAmountCents);
  }

  const maxRedemptions = input.max_redemptions === undefined || input.max_redemptions === null || input.max_redemptions === ''
    ? null
    : Number(input.max_redemptions);
  if (maxRedemptions !== null && (!Number.isFinite(maxRedemptions) || maxRedemptions < 1)) {
    throw new Error('max_redemptions must be a positive integer, or blank for unlimited');
  }

  const startsAt = input.starts_at ? new Date(input.starts_at) : null;
  if (startsAt && Number.isNaN(startsAt.getTime())) throw new Error('starts_at is not a valid date');
  const endsAt = input.ends_at ? new Date(input.ends_at) : null;
  if (endsAt && Number.isNaN(endsAt.getTime())) throw new Error('ends_at is not a valid date');
  if (startsAt && endsAt && endsAt <= startsAt) throw new Error('ends_at must be after starts_at');

  return {
    code, name,
    active: input.active === undefined ? true : Boolean(input.active),
    maxRedemptions,
    startsAt, endsAt,
    onboardingDays, onboardingPlan,
    onboardingLimits: input.onboarding_limits && typeof input.onboarding_limits === 'object' ? input.onboarding_limits : {},
    runwayPlan,
    runwayLimits: input.runway_limits && typeof input.runway_limits === 'object' ? input.runway_limits : {},
    runwayIntervalMonths,
    discountKind, discountPercent, discountAmountCents, discountCurrency,
  };
}

export function publicReferralCampaign(campaign) {
  return {
    id: campaign.id,
    code: campaign.code,
    name: campaign.name,
    active: campaign.active,
    max_redemptions: campaign.maxRedemptions,
    redemption_count: campaign.redemptionCount,
    starts_at: campaign.startsAt,
    ends_at: campaign.endsAt,
    onboarding_days: campaign.onboardingDays,
    onboarding_plan: campaign.onboardingPlan,
    onboarding_limits: campaign.onboardingLimits,
    runway_plan: campaign.runwayPlan,
    runway_limits: campaign.runwayLimits,
    runway_interval_months: campaign.runwayIntervalMonths,
    discount: buildReferralDiscount(campaign),
    created_at: campaign.createdAt,
    updated_at: campaign.updatedAt,
  };
}

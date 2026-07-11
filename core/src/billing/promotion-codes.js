import crypto from 'node:crypto';

export const hashPromotionCode = (code) => crypto.createHash('sha256').update(String(code || '').trim().toUpperCase()).digest('hex');

const integer = (value, min, max) => Number.isInteger(Number(value)) && Number(value) >= min && Number(value) <= max ? Number(value) : null;

export function normalizePromotionOffer(audience, input = {}) {
  if (!['personal', 'enterprise', 'both'].includes(audience)) throw new Error('invalid audience');
  const offer = {};
  if (audience !== 'enterprise') {
    const percentOff = integer(input.personal?.percent_off, 1, 100);
    const amountOffCents = integer(input.personal?.amount_off_cents, 1, 10_000_000);
    if (!percentOff && !amountOffCents) throw new Error('personal offer requires percent_off or amount_off_cents');
    offer.personal = {
      ...(percentOff ? { percent_off: percentOff } : { amount_off_cents: amountOffCents }),
      plans: Array.isArray(input.personal?.plans) ? input.personal.plans.filter((plan) => ['pro', 'scale'].includes(plan)) : ['pro', 'scale'],
    };
  }
  if (audience !== 'personal') {
    const onboardingDays = integer(input.enterprise?.onboarding_days, 1, 90);
    const onboardingPriceCents = integer(input.enterprise?.onboarding_price_cents, 0, 100_000_000);
    const runwayMonthlyCents = integer(input.enterprise?.runway_monthly_cents, 0, 100_000_000);
    if (!onboardingDays || onboardingPriceCents == null || runwayMonthlyCents == null) throw new Error('enterprise offer requires onboarding_days, onboarding_price_cents, and runway_monthly_cents');
    offer.enterprise = {
      onboarding_days: onboardingDays,
      onboarding_price_cents: onboardingPriceCents,
      runway_monthly_cents: runwayMonthlyCents,
      currency: String(input.enterprise?.currency || 'EUR').toUpperCase(),
      hosting_modes: Array.isArray(input.enterprise?.hosting_modes) ? input.enterprise.hosting_modes.filter((mode) => ['managed', 'self_host'].includes(mode)) : ['managed', 'self_host'],
    };
  }
  return offer;
}

export async function resolvePromotionCode(prisma, code, audience) {
  if (!code) return null;
  const row = await prisma.promotionCode.findUnique({ where: { codeHash: hashPromotionCode(code) } });
  const now = new Date();
  if (!row || row.revokedAt || (row.expiresAt && row.expiresAt <= now)) return null;
  if (![audience, 'both'].includes(row.audience)) return null;
  if (row.maxRedemptions != null && row.redemptionCount >= row.maxRedemptions) return null;
  return row;
}

export async function claimPromotionCode(prisma, code, audience, { planId, hostingMode } = {}) {
  const row = await resolvePromotionCode(prisma, code, audience);
  if (!row) return null;
  if (audience === 'personal' && planId && !row.offer?.personal?.plans?.includes(planId)) return null;
  if (audience === 'enterprise' && hostingMode && !row.offer?.enterprise?.hosting_modes?.includes(hostingMode)) return null;
  const claimed = await prisma.promotionCode.updateMany({
    where: { id: row.id, redemptionCount: row.redemptionCount, revokedAt: null },
    data: { redemptionCount: { increment: 1 } },
  });
  return claimed.count === 1 ? row : null;
}

import crypto from 'crypto';

import { getPlan } from './plans.js';
import { normalizeLimitOverrides } from './entitlements.js';
import { registerMnemeOrg } from '../vector/mneme/driver.js';

const ACCOUNT_PROFILES = {
  personal: { hostingMode: 'managed', storageMode: 'amr_embedded' },
  enterprise_managed: { hostingMode: 'managed', storageMode: 'hybrid' },
  enterprise_self_hosted: { hostingMode: 'self_host', storageMode: 'byod_amr' },
};
const FALLBACKS = new Set(['free', 'pro', 'scale', 'manual_review']);
const BILLING_MODES = new Set(['entitlement_only', 'stripe_discount', 'contract']);
const ELIGIBILITY_TYPES = new Set(['anyone', 'email', 'domain', 'organization', 'invite_only']);

function pepper() {
  const value = process.env.PROMOTION_CODE_PEPPER;
  if (value) return value;
  if (process.env.NODE_ENV === 'production') throw new Error('promotion service is not configured');
  return 'development-promotion-pepper';
}

export function normalizePromotionCode(value) {
  return String(value || '').trim().toUpperCase();
}

export function digestPromotionValue(value) {
  return crypto.createHmac('sha256', pepper()).update(String(value || '').trim().toLowerCase()).digest('hex');
}

export function promotionCodeHint(value) {
  const code = normalizePromotionCode(value);
  return code ? `${code.slice(0, 4)}${code.length > 4 ? '...' : ''}` : null;
}

function generateCode() {
  return `HM-${crypto.randomBytes(6).toString('base64url').replace(/[^A-Z0-9]/gi, '').slice(0, 8).toUpperCase()}`;
}

export function normalizeAccountProfile({ accountType, hostingMode, storageMode } = {}) {
  const type = String(accountType || '').trim().toLowerCase();
  const profile = ACCOUNT_PROFILES[type];
  if (!profile) throw new Error('invalid account type');
  const normalizedHosting = String(hostingMode || profile.hostingMode).trim().toLowerCase();
  const normalizedStorage = String(storageMode || profile.storageMode).trim().toLowerCase();
  const valid = (type === 'personal' && normalizedHosting === 'managed' && normalizedStorage === 'amr_embedded')
    || (type === 'enterprise_managed' && normalizedHosting === 'managed' && ['hybrid', 'hybrid_amr_index'].includes(normalizedStorage))
    || (type === 'enterprise_self_hosted' && normalizedHosting === 'self_host' && ['byod_amr', 'byod_hybrid'].includes(normalizedStorage));
  if (!valid) throw new Error('invalid account type and storage combination');
  return { accountType: type, hostingMode: normalizedHosting, storageMode: normalizedStorage };
}

function normalizeDate(value, field) {
  if (value == null || value === '') return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`invalid ${field}`);
  return date;
}

function normalizeCommercialTerms(value) {
  const terms = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = String(terms.kind || 'trial').toLowerCase();
  if (!['trial', 'percentage_discount', 'fixed_discount', 'custom_contract'].includes(kind)) throw new Error('invalid commercial offer');
  const out = { kind };
  if (terms.trial_days != null) {
    const days = Number(terms.trial_days);
    if (!Number.isInteger(days) || days < 1 || days > 365) throw new Error('trial_days must be 1..365');
    out.trial_days = days;
  }
  if (terms.percent_off != null) {
    const percent = Number(terms.percent_off);
    if (!Number.isInteger(percent) || percent < 1 || percent > 100) throw new Error('percent_off must be 1..100');
    out.percent_off = percent;
  }
  if (terms.amount_off_cents != null) {
    const amount = Number(terms.amount_off_cents);
    if (!Number.isSafeInteger(amount) || amount < 1) throw new Error('amount_off_cents must be positive');
    out.amount_off_cents = amount;
    out.currency = String(terms.currency || 'EUR').toUpperCase();
  }
  if (['percentage_discount', 'fixed_discount'].includes(kind)) {
    const duration = String(terms.discount_duration || 'once').toLowerCase();
    if (!['once', 'repeating', 'forever'].includes(duration)) throw new Error('invalid discount_duration');
    out.discount_duration = duration;
    if (duration === 'repeating') {
      const months = Number(terms.duration_in_months);
      if (!Number.isInteger(months) || months < 1 || months > 36) throw new Error('duration_in_months must be 1..36');
      out.duration_in_months = months;
    }
  }
  if (terms.stripe_coupon_id) out.stripe_coupon_id = String(terms.stripe_coupon_id).slice(0, 255);
  if (terms.stripe_promotion_code_id) out.stripe_promotion_code_id = String(terms.stripe_promotion_code_id).slice(0, 255);
  return out;
}

function normalizeEligibility(input, visibility) {
  const entries = Array.isArray(input) && input.length ? input : [{ type: visibility === 'invite_only' ? 'invite_only' : 'anyone' }];
  return entries.map((entry) => {
    const type = String(entry?.type || '').trim().toLowerCase();
    if (!ELIGIBILITY_TYPES.has(type)) throw new Error('invalid promotion eligibility');
    if (type === 'anyone' || type === 'invite_only') return { type, valueHash: null, valueHint: null };
    const raw = String(entry?.value || '').trim().toLowerCase();
    if (!raw) throw new Error(`eligibility ${type} requires a value`);
    if (type === 'email' && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw)) throw new Error('invalid eligibility email');
    if (type === 'domain' && !/^@[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) throw new Error('domain eligibility must begin with @');
    if (type === 'organization' && !/^[0-9a-f-]{36}$/i.test(raw)) throw new Error('invalid organization eligibility');
    return { type, valueHash: digestPromotionValue(raw), valueHint: type === 'email' ? raw.replace(/^(.{1,2}).*(@.*)$/, '$1***$2') : raw.slice(0, 160) };
  });
}

export function normalizePromotionInput(input = {}) {
  const visibility = String(input.visibility || 'code').toLowerCase();
  if (!['code', 'invite_only'].includes(visibility)) throw new Error('invalid promotion visibility');
  const code = visibility === 'code' ? normalizePromotionCode(input.code || generateCode()) : null;
  if (code && !/^[A-Z0-9][A-Z0-9_-]{2,63}$/.test(code)) throw new Error('code must be 3..64 letters, numbers, underscores, or hyphens');
  const basePlan = String(input.base_plan || 'free').toLowerCase();
  if (!getPlan(basePlan)) throw new Error('invalid base plan');
  const account = normalizeAccountProfile({ accountType: input.account_type, hostingMode: input.hosting_mode, storageMode: input.storage_mode });
  const startsAt = normalizeDate(input.starts_at, 'start date');
  const endsAt = normalizeDate(input.ends_at, 'expiry date');
  if (startsAt && endsAt && startsAt >= endsAt) throw new Error('expiry must be after start date');
  const maxRedemptions = input.max_redemptions == null || input.max_redemptions === '' ? null : Number(input.max_redemptions);
  if (maxRedemptions != null && (!Number.isSafeInteger(maxRedemptions) || maxRedemptions < 1)) throw new Error('max_redemptions must be positive');
  const perEmailMax = input.per_email_max == null ? 1 : Number(input.per_email_max);
  if (!Number.isSafeInteger(perEmailMax) || perEmailMax < 1 || perEmailMax > 100) throw new Error('invalid per_email_max');
  const billingMode = String(input.billing_mode || 'entitlement_only').toLowerCase();
  if (!BILLING_MODES.has(billingMode)) throw new Error('invalid billing mode');
  const commercialTerms = normalizeCommercialTerms(input.commercial_terms);
  if (billingMode === 'stripe_discount' && !['percentage_discount', 'fixed_discount'].includes(commercialTerms.kind)) throw new Error('Stripe promotions require a discount offer');
  if (billingMode === 'contract' && commercialTerms.kind !== 'custom_contract') throw new Error('contract promotions require a custom contract offer');
  const fallbackAction = String(input.fallback_action || 'manual_review').toLowerCase();
  if (!FALLBACKS.has(fallbackAction)) throw new Error('invalid fallback action');
  const limits = normalizeLimitOverrides(basePlan, input.limits);
  return {
    internalName: String(input.internal_name || '').trim().slice(0, 160),
    code, codeHash: code ? digestPromotionValue(code) : null, codeHint: promotionCodeHint(code), visibility,
    status: input.status === 'draft' ? 'draft' : 'active', billingMode, maxRedemptions, perEmailMax, startsAt, endsAt,
    notes: String(input.notes || '').trim().slice(0, 4000) || null,
    version: { basePlan, limits, ...account, commercialTerms, fallbackAction },
    eligibilities: normalizeEligibility(input.eligibilities, visibility),
  };
}

function currentVersion(versions) {
  return [...(versions || [])].sort((a, b) => b.version - a.version)[0] || null;
}

function isPromotionActive(promotion, now = new Date()) {
  return promotion?.status === 'active'
    && (!promotion.startsAt || promotion.startsAt <= now)
    && (!promotion.endsAt || promotion.endsAt > now)
    && (promotion.maxRedemptions == null || promotion.redemptionCount < promotion.maxRedemptions);
}

function eligibilityAllows(eligibilities, { email, orgId, allowInviteOnly = false }) {
  const entries = eligibilities || [];
  if (allowInviteOnly && entries.some((entry) => entry.eligibilityType === 'invite_only')) return true;
  if (entries.some((entry) => entry.eligibilityType === 'anyone')) return true;
  const normalizedEmail = String(email || '').trim().toLowerCase();
  const domain = normalizedEmail.includes('@') ? `@${normalizedEmail.split('@').pop()}` : '';
  return entries.some((entry) => (entry.eligibilityType === 'email' && entry.valueHash === digestPromotionValue(normalizedEmail))
    || (entry.eligibilityType === 'domain' && entry.valueHash === digestPromotionValue(domain))
    || (entry.eligibilityType === 'organization' && entry.valueHash === digestPromotionValue(orgId)));
}

function publicPromotion(promotion, version) {
  return {
    id: promotion.id, internal_name: promotion.internalName, code_hint: promotion.codeHint,
    visibility: promotion.visibility, status: promotion.status, billing_mode: promotion.billingMode,
    starts_at: promotion.startsAt, ends_at: promotion.endsAt, max_redemptions: promotion.maxRedemptions,
    redemption_count: promotion.redemptionCount, per_email_max: promotion.perEmailMax,
    version: version ? { id: version.id, number: version.version, base_plan: version.basePlan, limits: version.limits,
      account_type: version.accountType, hosting_mode: version.hostingMode, storage_mode: version.storageMode,
      commercial_terms: version.commercialTerms, fallback_action: version.fallbackAction } : null,
  };
}

export async function createPromotion({ prisma, tx: suppliedTx = null, input }) {
  const data = normalizePromotionInput(input);
  if (!data.internalName) throw new Error('internal_name is required');
  const work = async (tx) => {
    const promotion = await tx.promotion.create({ data: {
      internalName: data.internalName, codeHash: data.codeHash, codeHint: data.codeHint, visibility: data.visibility,
      status: data.status, billingMode: data.billingMode, maxRedemptions: data.maxRedemptions, perEmailMax: data.perEmailMax,
      startsAt: data.startsAt, endsAt: data.endsAt, notes: data.notes,
    } });
    const version = await tx.promotionVersion.create({ data: { promotionId: promotion.id, version: 1, ...data.version } });
    await tx.promotionEligibility.createMany({ data: data.eligibilities.map((entry) => ({ promotionId: promotion.id, eligibilityType: entry.type, valueHash: entry.valueHash, valueHint: entry.valueHint })) });
    return { promotion: publicPromotion(promotion, version), plaintextCode: data.code };
  };
  return suppliedTx ? work(suppliedTx) : prisma.$transaction(work);
}

export async function listPromotions(prisma) {
  const promotions = await prisma.promotion.findMany({ orderBy: { createdAt: 'desc' } });
  const ids = promotions.map((promotion) => promotion.id);
  const versions = ids.length ? await prisma.promotionVersion.findMany({ where: { promotionId: { in: ids } }, orderBy: { version: 'desc' } }) : [];
  return promotions.map((promotion) => publicPromotion(promotion, currentVersion(versions.filter((version) => version.promotionId === promotion.id))));
}

export async function findPromotionForCode({ prisma, code, email, orgId, now = new Date() }) {
  const normalized = normalizePromotionCode(code);
  if (!normalized) return null;
  const promotion = await prisma.promotion.findUnique({ where: { codeHash: digestPromotionValue(normalized) } });
  if (!isPromotionActive(promotion, now) || promotion.visibility !== 'code') return null;
  const [versions, eligibilities] = await Promise.all([
    prisma.promotionVersion.findMany({ where: { promotionId: promotion.id }, orderBy: { version: 'desc' }, take: 1 }),
    prisma.promotionEligibility.findMany({ where: { promotionId: promotion.id } }),
  ]);
  const version = currentVersion(versions);
  if (!version || !eligibilityAllows(eligibilities, { email, orgId })) return null;
  return { promotion, version, eligibilities, code: normalized };
}

export async function findPromotionById({ prisma, promotionId, email, orgId, now = new Date(), allowInviteOnly = false }) {
  const promotion = await prisma.promotion.findUnique({ where: { id: promotionId } });
  if (!isPromotionActive(promotion, now)) return null;
  const [versions, eligibilities] = await Promise.all([
    prisma.promotionVersion.findMany({ where: { promotionId }, orderBy: { version: 'desc' }, take: 1 }),
    prisma.promotionEligibility.findMany({ where: { promotionId } }),
  ]);
  const version = currentVersion(versions);
  if (!version || !eligibilityAllows(eligibilities, { email, orgId, allowInviteOnly })) return null;
  return { promotion, version, eligibilities, code: null };
}

async function activePromotionGrant(tx, orgId, now) {
  return tx.entitlementGrant.findFirst({ where: { orgId, status: 'active', startsAt: { lte: now }, OR: [{ endsAt: null }, { endsAt: { gt: now } }] }, orderBy: { startsAt: 'desc' } });
}

function promotionEnd(promotion, version, now) {
  if (promotion.endsAt) return promotion.endsAt;
  const days = Number(version.commercialTerms?.trial_days || 0);
  return days ? new Date(now.getTime() + days * 24 * 60 * 60 * 1000) : null;
}

export async function redeemPromotion({ prisma, tx: suppliedTx = null, orgId, userId, email, code = null, promotionId = null, partnerReferralCampaignId = null, requestId = null, now = new Date(), applyProfile = false, allowInviteOnly = false }) {
  const work = async (tx) => {
    const resolved = promotionId
      ? await findPromotionById({ prisma: tx, promotionId, email, orgId, now, allowInviteOnly })
      : await findPromotionForCode({ prisma: tx, code, email, orgId, now });
    if (!resolved) throw new Error('promotion unavailable');
    const { promotion, version } = resolved;
    const perEmailCount = await tx.promotionRedemption.count({ where: { promotionId: promotion.id, emailHash: digestPromotionValue(email) } });
    if (perEmailCount >= promotion.perEmailMax) throw new Error('promotion unavailable');
    if (await activePromotionGrant(tx, orgId, now)) throw new Error('organization already has an active promotion');
    const claimed = await tx.promotion.updateMany({ where: { id: promotion.id, status: 'active', ...(promotion.maxRedemptions == null ? {} : { redemptionCount: { lt: promotion.maxRedemptions } }) }, data: { redemptionCount: { increment: 1 } } });
    if (claimed.count !== 1) throw new Error('promotion unavailable');
    const endsAt = promotionEnd(promotion, version, now);
    const grant = await tx.entitlementGrant.create({ data: { orgId, promotionId: promotion.id, source: 'promotion', status: 'active', startsAt: now, endsAt, fallbackAction: version.fallbackAction } });
    const entitlementVersion = await tx.entitlementVersion.create({ data: { grantId: grant.id, version: 1, planId: version.basePlan, limits: version.limits,
      accountType: version.accountType, hostingMode: version.hostingMode, storageMode: version.storageMode,
      commercialTerms: version.commercialTerms, effectiveFrom: now, transitionReason: 'promotion_redemption' } });
    await tx.organizationEntitlement.create({ data: { orgId, source: 'promotion', phase: 'grant', planId: version.basePlan, limits: version.limits, effectiveFrom: now, effectiveUntil: endsAt } });
    if (applyProfile) {
      await tx.organization.update({ where: { id: orgId }, data: { plan: version.basePlan, accountType: version.accountType, hostingMode: version.hostingMode, memoryStorageMode: version.storageMode, subscriptionStatus: 'active', trialEndsAt: endsAt } });
      // Forward-only fix: route this org to .amr the moment it's promoted, not
      // just when someone next restarts the process and re-reads MNEME_ORGS.
      // Safe here specifically because a freshly redeemed org has no prior
      // memories to backfill. See driver.js registerMnemeOrg() for why
      // existing mis-routed orgs are deliberately NOT touched by this path.
      if (version.storageMode === 'amr_embedded') registerMnemeOrg(orgId);
    }
    const termsSnapshot = { promotion: publicPromotion(promotion, version), grant_ends_at: endsAt?.toISOString() || null };
    const redemption = await tx.promotionRedemption.create({ data: { promotionId: promotion.id, promotionVersionId: version.id, entitlementGrantId: grant.id, orgId, redeemedByUserId: userId,
      emailHash: digestPromotionValue(email), codeHint: promotion.codeHint, termsSnapshot, requestId, partnerReferralCampaignId } });
    return { promotion: publicPromotion(promotion, version), grant, entitlementVersion, redemption, termsSnapshot };
  };
  return suppliedTx ? work(suppliedTx) : prisma.$transaction(work);
}

/** Platform-admin path for invite-only and named pilot grants. It creates the
 * same immutable redemption/grant/version chain as a normal code redemption. */
export async function grantPromotionToOrganization({ prisma, promotionId, orgId, userId, requestId = null, now = new Date() }) {
  return prisma.$transaction(async (tx) => {
    const promotion = await tx.promotion.findUnique({ where: { id: promotionId } });
    if (!isPromotionActive(promotion, now)) throw new Error('promotion unavailable');
    const [versions, eligibilities] = await Promise.all([
      tx.promotionVersion.findMany({ where: { promotionId }, orderBy: { version: 'desc' }, take: 1 }),
      tx.promotionEligibility.findMany({ where: { promotionId } }),
    ]);
    const version = currentVersion(versions);
    const org = await tx.organization.findUnique({ where: { id: orgId }, select: { id: true } });
    if (!org || !version) throw new Error('organization or promotion unavailable');
    const owner = await tx.userOrganization.findFirst({ where: { orgId, role: 'owner' }, select: { userId: true } });
    if (!owner) throw new Error('organization has no owner');
    // A targeted promotion may only be granted to its declared organization.
    const targetEligibility = eligibilities.filter((entry) => entry.eligibilityType === 'organization');
    if (targetEligibility.length && !targetEligibility.some((entry) => entry.valueHash === digestPromotionValue(orgId))) {
      throw new Error('promotion unavailable');
    }
    if (await activePromotionGrant(tx, orgId, now)) throw new Error('organization already has an active promotion');
    const claimed = await tx.promotion.updateMany({ where: { id: promotionId, status: 'active', ...(promotion.maxRedemptions == null ? {} : { redemptionCount: { lt: promotion.maxRedemptions } }) }, data: { redemptionCount: { increment: 1 } } });
    if (claimed.count !== 1) throw new Error('promotion unavailable');
    const endsAt = promotionEnd(promotion, version, now);
    const grant = await tx.entitlementGrant.create({ data: { orgId, promotionId, source: 'admin_pilot', status: 'active', startsAt: now, endsAt, fallbackAction: version.fallbackAction } });
    const entitlementVersion = await tx.entitlementVersion.create({ data: { grantId: grant.id, version: 1, planId: version.basePlan, limits: version.limits,
      accountType: version.accountType, hostingMode: version.hostingMode, storageMode: version.storageMode,
      commercialTerms: version.commercialTerms, effectiveFrom: now, transitionReason: 'platform_admin_grant' } });
    await tx.organizationEntitlement.create({ data: { orgId, source: 'promotion', phase: 'grant', planId: version.basePlan, limits: version.limits, effectiveFrom: now, effectiveUntil: endsAt } });
    await tx.organization.update({ where: { id: orgId }, data: { plan: version.basePlan, accountType: version.accountType, hostingMode: version.hostingMode, memoryStorageMode: version.storageMode, subscriptionStatus: 'active', trialEndsAt: endsAt } });
    if (version.storageMode === 'amr_embedded') registerMnemeOrg(orgId);
    const redemption = await tx.promotionRedemption.create({ data: { promotionId, promotionVersionId: version.id, entitlementGrantId: grant.id, orgId,
      redeemedByUserId: owner.userId, emailHash: digestPromotionValue(`admin:${orgId}`), codeHint: promotion.codeHint,
      termsSnapshot: { promotion: publicPromotion(promotion, version), grant_ends_at: endsAt?.toISOString() || null, issued_by: 'platform_admin' }, requestId } });
    return { promotion: publicPromotion(promotion, version), grant, entitlementVersion, redemption };
  });
}

export async function getEffectivePromotionEntitlement(prisma, orgId, now = new Date()) {
  // A terminal grant status is authoritative over legacy entitlement projections.
  // Otherwise a suspended pilot could fall through to an older paid-plan row.
  const grant = await prisma.entitlementGrant.findFirst({
    where: { orgId, startsAt: { lte: now }, status: { in: ['active', 'suspended', 'revoked'] } },
    orderBy: { startsAt: 'desc' },
  });
  if (!grant) return null;
  if (grant.status === 'suspended' || grant.status === 'revoked') {
    return { grant, status: grant.status, version: null };
  }
  if (grant.endsAt && grant.endsAt <= now) return { grant, status: grant.fallbackAction === 'manual_review' ? 'manual_review' : 'expired', version: null };
  const version = await prisma.entitlementVersion.findFirst({ where: { grantId: grant.id, effectiveFrom: { lte: now }, OR: [{ effectiveUntil: null }, { effectiveUntil: { gt: now } }] }, orderBy: { version: 'desc' } });
  return version ? { grant, version, status: 'active' } : null;
}

export async function amendEntitlementGrant({ prisma, grantId, patch, now = new Date() }) {
  return prisma.$transaction(async (tx) => {
    const grant = await tx.entitlementGrant.findUnique({ where: { id: grantId } });
    if (!grant) throw new Error('grant not found');
    const previous = await tx.entitlementVersion.findFirst({ where: { grantId }, orderBy: { version: 'desc' } });
    if (!previous) throw new Error('grant has no version');
    const profile = normalizeAccountProfile({ accountType: patch.account_type || previous.accountType, hostingMode: patch.hosting_mode || previous.hostingMode, storageMode: patch.storage_mode || previous.storageMode });
    const planId = String(patch.base_plan || previous.planId).toLowerCase();
    getPlan(planId);
    const limits = normalizeLimitOverrides(planId, patch.limits || previous.limits);
    const endsAt = patch.ends_at === undefined ? grant.endsAt : normalizeDate(patch.ends_at, 'expiry date');
    if (endsAt && endsAt <= now) throw new Error('expiry must be in the future');
    const fallbackAction = patch.fallback_action === undefined ? grant.fallbackAction : String(patch.fallback_action).toLowerCase();
    if (!FALLBACKS.has(fallbackAction)) throw new Error('invalid fallback action');
    const status = patch.status === undefined ? grant.status : String(patch.status).toLowerCase();
    if (!['active', 'suspended', 'revoked'].includes(status)) throw new Error('invalid grant status');
    // Versions are immutable commercial history. The resolver selects the highest
    // effective version, so a successor supersedes its predecessor without
    // rewriting the earlier grant terms.
    const next = await tx.entitlementVersion.create({ data: { grantId, version: previous.version + 1, planId, limits, ...profile,
      commercialTerms: previous.commercialTerms, effectiveFrom: now, transitionReason: String(patch.reason || 'admin_adjustment').slice(0, 80) } });
    const updated = await tx.entitlementGrant.update({ where: { id: grantId }, data: { endsAt, fallbackAction,
      status, suspendedAt: status === 'suspended' ? now : null } });
    return { grant: updated, version: next };
  });
}

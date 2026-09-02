import crypto from 'crypto';

import { createPromotion, digestPromotionValue, findPromotionById, redeemPromotion } from './promotion-service.js';

const EMAIL = /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/;

function safeEqual(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function tokenSignature(id, version) {
  return digestPromotionValue(`partner-referral:${id}:${version}`);
}

export function createPartnerReferralToken(id, version = 1) {
  return `${id}.${version}.${tokenSignature(id, version)}`;
}

function parsePartnerReferralToken(token) {
  const [id, versionRaw, signature, extra] = String(token || '').split('.');
  const version = Number(versionRaw);
  if (extra || !/^[0-9a-f-]{36}$/i.test(id || '') || !Number.isInteger(version) || version < 1) return null;
  if (!safeEqual(signature, tokenSignature(id, version))) return null;
  return { id, version };
}

function emailHint(value) {
  return String(value).replace(/^(.{1,2}).*(@.*)$/, '$1***$2').slice(0, 160);
}

function publicOffer(row) {
  const version = row.promotion?.versions?.[0];
  const terms = version?.commercialTerms || {};
  return {
    campaign_id: row.id,
    referrer: { display_name: row.referrerDisplayName },
    welcome_message: row.welcomeMessage,
    offer: {
      plan: version?.basePlan,
      account_type: version?.accountType,
      hosting_mode: version?.hostingMode,
      storage_mode: version?.storageMode,
      trial_days: Number(terms.trial_days || 0),
      monthly_credits: Number(version?.limits?.monthlyCredits || 0),
      discount: ['percentage_discount', 'fixed_discount'].includes(terms.kind) ? terms : null,
      fallback_action: version?.fallbackAction,
      expires_at: row.promotion?.endsAt,
    },
  };
}

function adminCampaign(row, baseUrl) {
  return {
    ...publicOffer(row),
    promotion_id: row.promotionId,
    internal_name: row.promotion?.internalName,
    referrer_email: row.referrerEmail,
    referrer_email_hint: row.referrerEmailHint,
    status: row.promotion?.status,
    delivery_status: row.deliveryStatus,
    last_delivery_error: row.lastDeliveryError,
    sent_at: row.sentAt,
    last_sent_at: row.lastSentAt,
    visit_count: row.visitCount,
    accepted_count: row.acceptedCount,
    created_at: row.createdAt,
    invitation_url: `${baseUrl}/hivemind/app/invite?referral_token=${encodeURIComponent(createPartnerReferralToken(row.id, row.shareTokenVersion))}`,
  };
}

const includeOffer = { promotion: { include: { versions: { orderBy: { version: 'desc' }, take: 1 } } } };

export async function createPartnerReferralCampaign({ prisma, input, baseUrl }) {
  const referrerDisplayName = String(input.referrer_display_name || '').trim().slice(0, 120);
  const referrerEmail = String(input.referrer_email || '').trim().toLowerCase();
  if (!referrerDisplayName) throw new Error('referrer_display_name is required');
  if (!EMAIL.test(referrerEmail)) throw new Error('a valid referrer_email is required');
  const trialDays = Number(input.trial_days);
  if (!Number.isInteger(trialDays) || trialDays < 1 || trialDays > 365) throw new Error('trial_days must be 1..365');
  const monthlyCredits = Number(input.monthly_credits);
  if (!Number.isSafeInteger(monthlyCredits) || monthlyCredits < 0 || monthlyCredits > 100_000_000) throw new Error('monthly_credits is invalid');
  const discountKind = String(input.discount_kind || 'none').toLowerCase();
  const terms = { kind: discountKind === 'none' ? 'trial' : `${discountKind}_discount`, trial_days: trialDays };
  if (discountKind === 'percentage') terms.percent_off = Number(input.discount_percent);
  if (discountKind === 'fixed') {
    terms.amount_off_cents = Number(input.discount_amount_cents);
    terms.currency = String(input.discount_currency || 'EUR').toUpperCase();
  }
  if (discountKind !== 'none') {
    terms.discount_duration = input.discount_duration || 'once';
    if (terms.discount_duration === 'repeating') terms.duration_in_months = Number(input.duration_in_months);
  }
  const created = await prisma.$transaction(async (tx) => {
    const promotion = await createPromotion({ prisma, tx, input: {
      internal_name: input.internal_name || `${referrerDisplayName} partner invitation`,
      code: input.code,
      visibility: 'code',
      status: discountKind === 'none' ? 'active' : 'draft',
      billing_mode: discountKind === 'none' ? 'entitlement_only' : 'stripe_discount',
      account_type: input.account_type || 'personal',
      base_plan: input.base_plan || 'free',
      limits: { monthlyCredits },
      commercial_terms: terms,
      fallback_action: input.fallback_action || 'free',
      max_redemptions: input.max_redemptions,
      per_email_max: 1,
      starts_at: input.starts_at,
      ends_at: input.ends_at,
      eligibilities: [{ type: 'anyone' }],
      notes: input.notes,
    } });
    const id = crypto.randomUUID();
    const version = 1;
    await tx.partnerReferralCampaign.create({ data: {
      id,
      promotionId: promotion.promotion.id,
      referrerDisplayName,
      referrerEmail,
      referrerEmailHash: digestPromotionValue(referrerEmail),
      referrerEmailHint: emailHint(referrerEmail),
      shareTokenHash: digestPromotionValue(createPartnerReferralToken(id, version)),
      shareTokenVersion: version,
      welcomeMessage: String(input.welcome_message || '').trim().slice(0, 1200) || null,
    } });
    return promotion;
  });
  const row = await prisma.partnerReferralCampaign.findUnique({ where: { promotionId: created.promotion.id }, include: includeOffer });
  return { campaign: adminCampaign(row, baseUrl), plaintextCode: created.plaintextCode };
}

export async function listPartnerReferralCampaigns({ prisma, baseUrl }) {
  const rows = await prisma.partnerReferralCampaign.findMany({ include: includeOffer, orderBy: { createdAt: 'desc' } });
  return rows.map((row) => adminCampaign(row, baseUrl));
}

export async function getPartnerReferralCampaign({ prisma, campaignId, baseUrl }) {
  const row = await prisma.partnerReferralCampaign.findUnique({ where: { id: campaignId }, include: includeOffer });
  return row ? { row, campaign: adminCampaign(row, baseUrl) } : null;
}

export async function resolvePartnerReferral({ prisma, token, email = '', orgId = null, recordVisit = false, now = new Date() }) {
  const parsed = parsePartnerReferralToken(token);
  if (!parsed) return null;
  const row = await prisma.partnerReferralCampaign.findUnique({ where: { id: parsed.id }, include: includeOffer });
  if (!row || row.shareTokenVersion !== parsed.version || !safeEqual(row.shareTokenHash, digestPromotionValue(token))) return null;
  const promotion = await findPromotionById({ prisma, promotionId: row.promotionId, email, orgId, now });
  if (!promotion) return null;
  if (recordVisit) await prisma.partnerReferralCampaign.update({ where: { id: row.id }, data: { visitCount: { increment: 1 } } });
  return { row, promotion, preview: publicOffer(row) };
}

export async function redeemPartnerReferral({ prisma, tx, token, orgId, userId, email, requestId = null }) {
  const resolved = await resolvePartnerReferral({ prisma: tx, token, email, orgId });
  if (!resolved) throw new Error('referral invitation unavailable');
  const result = await redeemPromotion({ prisma, tx, promotionId: resolved.row.promotionId, partnerReferralCampaignId: resolved.row.id,
    orgId, userId, email, requestId, applyProfile: true });
  await tx.partnerReferralCampaign.update({ where: { id: resolved.row.id }, data: { acceptedCount: { increment: 1 } } });
  return { ...result, referral: resolved.preview };
}

export async function markPartnerReferralDelivery({ prisma, campaignId, delivery }) {
  const now = new Date();
  return prisma.partnerReferralCampaign.update({ where: { id: campaignId }, data: {
    deliveryStatus: delivery.ok ? 'sent' : 'failed',
    lastDeliveryError: delivery.ok ? null : String(delivery.error || 'delivery_failed').slice(0, 240),
    lastSentAt: now,
    ...(delivery.ok ? { sentAt: now } : {}),
  } });
}

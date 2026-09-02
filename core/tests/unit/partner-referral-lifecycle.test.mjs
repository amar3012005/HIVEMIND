import assert from 'node:assert/strict';
import test from 'node:test';

import { createPartnerReferralCampaign, createPartnerReferralToken, listPartnerReferralCampaigns, markPartnerReferralDelivery, redeemPartnerReferral, resolvePartnerReferral } from '../../src/billing/partner-referral-service.js';
import { normalizePromotionInput } from '../../src/billing/promotion-service.js';
import { createSignupAdmission, verifySignupAdmission } from '../../src/control-plane/signup-admission.js';
import { renderPartnerReferralInvitation } from '../../src/email/templates/partner-referral-invitation.js';

test('partner referral token is stable for a campaign version and changes on rotation', () => {
  const id = '11111111-1111-4111-8111-111111111111';
  assert.equal(createPartnerReferralToken(id, 1), createPartnerReferralToken(id, 1));
  assert.notEqual(createPartnerReferralToken(id, 1), createPartnerReferralToken(id, 2));
});

test('signup admission binds the referral campaign and account type', () => {
  const ticket = createSignupAdmission({ accountType: 'enterprise', secret: 'test-secret', partnerReferral: { id: '11111111-1111-4111-8111-111111111111', version: 2 } });
  const verified = verifySignupAdmission({ ticket, accountType: 'enterprise', secret: 'test-secret' });
  assert.deepEqual(verified.partnerReferral, { id: '11111111-1111-4111-8111-111111111111', version: 2 });
  assert.equal(verifySignupAdmission({ ticket, accountType: 'personal', secret: 'test-secret' }), null);
});

test('discount terms preserve trial and Stripe duration', () => {
  const normalized = normalizePromotionInput({
    internal_name: 'Wolfgang 2026', code: 'WOLFX2026', base_plan: 'pro', account_type: 'personal', fallback_action: 'free', billing_mode: 'stripe_discount',
    limits: { monthlyCredits: 5000 }, commercial_terms: { kind: 'percentage_discount', percent_off: 100, trial_days: 21, discount_duration: 'repeating', duration_in_months: 3 },
  });
  assert.deepEqual(normalized.version.commercialTerms, { kind: 'percentage_discount', trial_days: 21, percent_off: 100, discount_duration: 'repeating', duration_in_months: 3 });
  assert.equal(normalized.version.limits.monthlyCredits, 5000);
});

test('partner referral delivery gives Wolfgang a share-ready card-free invitation', () => {
  const rendered = renderPartnerReferralInvitation({ referrerName: 'Wolfgang', invitationUrl: 'https://next.singulancelabs.com/hivemind/app/invite?referral_token=safe', offer: { trial_days: 21, monthly_credits: 5000, plan: 'pro' } });
  assert.match(rendered.subject, /ready to share/);
  assert.match(rendered.html, /SINGULANCE/);
  assert.match(rendered.html, /21 days/);
  assert.match(rendered.html, /5,000/);
  assert.match(rendered.html, /TRIAL PLAN/);
  assert.match(rendered.html, /No payment method is required/);
  assert.match(rendered.html, /share=1/);
  assert.doesNotMatch(rendered.html, /off after trial/i);
  assert.match(rendered.text, /referral_token=safe/);
});

function inMemoryPrisma() {
  const db = { promotions: [], versions: [], eligibilities: [], campaigns: [], redemptions: [], grants: [], entitlementVersions: [], orgEntitlements: [], organizations: [{ id: '22222222-2222-4222-8222-222222222222' }] };
  let sequence = 0;
  const id = () => `00000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const withOffer = (row) => ({ ...row, promotion: { ...db.promotions.find((p) => p.id === row.promotionId), versions: db.versions.filter((v) => v.promotionId === row.promotionId).sort((a, b) => b.version - a.version).slice(0, 1) } });
  const prisma = {
    $transaction: async (work) => typeof work === 'function' ? work(prisma) : Promise.all(work),
    promotion: {
      create: async ({ data }) => { const row = { id: id(), redemptionCount: 0, createdAt: new Date(), updatedAt: new Date(), ...data }; db.promotions.push(row); return row; },
      findUnique: async ({ where }) => db.promotions.find((row) => row.id === where.id || row.codeHash === where.codeHash) || null,
      updateMany: async ({ where }) => { const row = db.promotions.find((p) => p.id === where.id && p.status === where.status && (where.redemptionCount == null || p.redemptionCount < where.redemptionCount.lt)); if (!row) return { count: 0 }; row.redemptionCount += 1; return { count: 1 }; },
    },
    promotionVersion: {
      create: async ({ data }) => { const row = { id: id(), createdAt: new Date(), ...data }; db.versions.push(row); return row; },
      findMany: async ({ where, take }) => db.versions.filter((row) => {
        if (where.promotionId?.in) return where.promotionId.in.includes(row.promotionId);
        return row.promotionId === where.promotionId;
      }).sort((a, b) => b.version - a.version).slice(0, take || undefined),
    },
    promotionEligibility: {
      createMany: async ({ data }) => { db.eligibilities.push(...data.map((row) => ({ id: id(), ...row }))); },
      findMany: async ({ where }) => db.eligibilities.filter((row) => row.promotionId === where.promotionId),
    },
    partnerReferralCampaign: {
      create: async ({ data }) => { const row = { createdAt: new Date(), updatedAt: new Date(), visitCount: 0, acceptedCount: 0, deliveryStatus: 'not_sent', ...data }; db.campaigns.push(row); return row; },
      findUnique: async ({ where }) => { const row = db.campaigns.find((c) => c.id === where.id || c.promotionId === where.promotionId); return row ? withOffer(row) : null; },
      findMany: async () => db.campaigns.map(withOffer),
      update: async ({ where, data }) => { const row = db.campaigns.find((c) => c.id === where.id); if (data.acceptedCount?.increment) row.acceptedCount += data.acceptedCount.increment; if (data.visitCount?.increment) row.visitCount += data.visitCount.increment; Object.assign(row, Object.fromEntries(Object.entries(data).filter(([, value]) => !value || typeof value !== 'object' || value instanceof Date))); return row; },
    },
    promotionRedemption: { count: async ({ where }) => db.redemptions.filter((row) => row.promotionId === where.promotionId && row.emailHash === where.emailHash).length, create: async ({ data }) => { const row = { id: id(), ...data }; db.redemptions.push(row); return row; } },
    entitlementGrant: { findFirst: async ({ where }) => db.grants.find((row) => row.orgId === where.orgId && row.status === 'active' && (!row.endsAt || row.endsAt > new Date())) || null, create: async ({ data }) => { const row = { id: id(), ...data }; db.grants.push(row); return row; } },
    entitlementVersion: { create: async ({ data }) => { const row = { id: id(), ...data }; db.entitlementVersions.push(row); return row; } },
    organizationEntitlement: { create: async ({ data }) => { db.orgEntitlements.push(data); return data; } },
    organization: { update: async ({ where, data }) => { const row = db.organizations.find((org) => org.id === where.id); Object.assign(row, data); return row; } },
  };
  return { prisma, db };
}

test('Wolfgang URL creates a reusable card-free trial and atomically grants the exact offer', async () => {
  const { prisma, db } = inMemoryPrisma();
  const created = await createPartnerReferralCampaign({ prisma, baseUrl: 'https://next.singulancelabs.com', input: {
    referrer_display_name: 'Wolfgang', referrer_email: 'wolfgang@example.com', code: 'WOLFX2026', account_type: 'enterprise_managed', base_plan: 'scale', trial_days: 30,
    monthly_credits: 10000, discount_kind: 'percentage', discount_percent: 100, fallback_action: 'free', max_redemptions: 25,
  } });
  const token = new URL(created.campaign.invitation_url).searchParams.get('referral_token');
  assert.match(created.campaign.invitation_url, /\/hivemind\/invite\?referral_token=/);
  assert.doesNotMatch(created.campaign.invitation_url, /\/hivemind\/app\/invite/);
  const preview = await resolvePartnerReferral({ prisma, token, recordVisit: true });
  assert.equal(preview.preview.referrer.display_name, 'Wolfgang');
  assert.equal(preview.preview.offer.monthly_credits, 10000);
  assert.equal(preview.preview.offer.remaining_activations, 25);
  assert.equal(db.promotions[0].billingMode, 'entitlement_only');
  assert.equal(db.promotions[0].status, 'active');
  assert.deepEqual(db.versions[0].commercialTerms, { kind: 'trial', trial_days: 30 });
  assert.equal(db.promotions[0].codeHint, null);
  const redeemed = await redeemPartnerReferral({ prisma, tx: prisma, token, orgId: db.organizations[0].id, userId: '33333333-3333-4333-8333-333333333333', email: 'invitee@example.com' });
  assert.equal(redeemed.promotion.version.base_plan, 'scale');
  assert.equal(db.promotions[0].redemptionCount, 1);
  assert.equal(db.campaigns[0].acceptedCount, 1);
  assert.equal(db.redemptions[0].partnerReferralCampaignId, db.campaigns[0].id);
  assert.equal(db.organizations[0].plan, 'scale');
  assert.equal(redeemed.termsSnapshot.promotion.version.limits.monthlyCredits, 10000);
  assert.equal(redeemed.termsSnapshot.promotion.version.account_type, 'enterprise_managed');
  await assert.rejects(
    redeemPartnerReferral({ prisma, tx: prisma, token, orgId: db.organizations[0].id, userId: '33333333-3333-4333-8333-333333333333', email: 'invitee@example.com' }),
    /promotion unavailable|active promotion/,
  );
});

test('partner referral administration lists campaigns without a nonexistent Promotion relation', async () => {
  const { prisma } = inMemoryPrisma();
  await createPartnerReferralCampaign({ prisma, baseUrl: 'https://next.singulancelabs.com', input: {
    referrer_display_name: 'Wolfgang', referrer_email: 'wolfgang@example.com', code: 'WOLFX-LIST', account_type: 'personal', base_plan: 'plus', trial_days: 14,
    monthly_credits: 2000, discount_kind: 'none', fallback_action: 'free', max_redemptions: 5,
  } });
  const campaigns = await listPartnerReferralCampaigns({ prisma, baseUrl: 'https://next.singulancelabs.com' });
  assert.equal(campaigns.length, 1);
  assert.equal(campaigns[0].offer.monthly_credits, 2000);
  assert.equal(campaigns[0].internal_name, 'Wolfgang partner invitation');
});

test('expired and exhausted partner links fail closed', async () => {
  const { prisma, db } = inMemoryPrisma();
  const created = await createPartnerReferralCampaign({ prisma, baseUrl: 'https://next.singulancelabs.com', input: {
    referrer_display_name: 'Wolfgang', referrer_email: 'wolfgang@example.com', code: 'WOLFX-LIMIT', account_type: 'personal', base_plan: 'plus', trial_days: 14,
    monthly_credits: 2000, discount_kind: 'none', fallback_action: 'free', max_redemptions: 1,
  } });
  const token = new URL(created.campaign.invitation_url).searchParams.get('referral_token');
  db.promotions[0].endsAt = new Date('2026-01-01T00:00:00.000Z');
  assert.equal(await resolvePartnerReferral({ prisma, token, now: new Date('2026-01-02T00:00:00.000Z') }), null);
  db.promotions[0].endsAt = null;
  db.promotions[0].redemptionCount = 1;
  assert.equal(await resolvePartnerReferral({ prisma, token }), null);
});

test('delivery receipt records sent and failed Day-0 attempts', async () => {
  const { prisma, db } = inMemoryPrisma();
  const created = await createPartnerReferralCampaign({ prisma, baseUrl: 'https://next.singulancelabs.com', input: {
    referrer_display_name: 'Wolfgang', referrer_email: 'wolfgang@example.com', code: 'WOLFX-SEND', account_type: 'personal', base_plan: 'free', trial_days: 7,
    monthly_credits: 500, discount_kind: 'none', fallback_action: 'free', max_redemptions: 50,
  } });
  await markPartnerReferralDelivery({ prisma, campaignId: created.campaign.campaign_id, delivery: { ok: false, error: 'provider unavailable' } });
  assert.equal(db.campaigns[0].deliveryStatus, 'failed');
  assert.match(db.campaigns[0].lastDeliveryError, /provider unavailable/);
  await markPartnerReferralDelivery({ prisma, campaignId: created.campaign.campaign_id, delivery: { ok: true } });
  assert.equal(db.campaigns[0].deliveryStatus, 'sent');
  assert.equal(db.campaigns[0].lastDeliveryError, null);
  assert.ok(db.campaigns[0].sentAt instanceof Date);
});

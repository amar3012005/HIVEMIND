import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildReferralOffer,
  buildStandardOffer,
  claimReferralOffer,
  mergeEntitlementPlan,
  normalizeLimitOverrides,
  normalizeReferralCode,
} from '../../src/billing/entitlements.js';
import { UsageTracker } from '../../src/billing/usage-tracker.js';

describe('referral entitlements', () => {
  it('normalizes codes without accepting browser-defined terms', () => {
    assert.equal(normalizeReferralCode(' gtm2026 '), 'GTM2026');
    assert.equal(normalizeReferralCode(null), '');
  });

  it('overrides only the campaign limits while retaining plan features', () => {
    const plan = mergeEntitlementPlan('enterprise', { maxUsers: 12, llmTokensPerMonth: 5_000_000 });
    assert.equal(plan.id, 'enterprise');
    assert.equal(plan.limits.maxUsers, 12);
    assert.equal(plan.limits.llmTokensPerMonth, 5_000_000);
    assert.equal(plan.features.ssoSaml, true);
  });

  it('drops unknown, fractional, and negative limit overrides', () => {
    assert.deepEqual(normalizeLimitOverrides('pro', {
      maxUsers: 12,
      llmTokensPerMonth: -1,
      maxConnectors: 2.5,
      inventedLimit: 999,
    }), { maxUsers: 12, llmTokensPerMonth: -1 });
  });

  it('builds server-owned standard and referral offers', () => {
    const now = new Date('2026-07-10T00:00:00.000Z');
    const standard = buildStandardOffer('pro', now);
    assert.equal(standard.target_plan, 'pro');
    assert.equal(standard.onboarding_days, 14);

    const referral = buildReferralOffer({
      id: 'campaign-id', code: 'GTM2026', onboardingDays: 14,
      onboardingPlan: 'enterprise', onboardingLimits: { maxUsers: 25, invalid: 1 },
      runwayPlan: 'scale', runwayLimits: { maxUsers: 10 },
    }, now);
    assert.deepEqual(referral.onboarding_limits, { maxUsers: 25 });
    assert.deepEqual(referral.runway_limits, { maxUsers: 10 });
  });

  it('returns the activated plan for post-payment provisioning', async () => {
    const campaign = {
      id: 'campaign-id', code: 'GTM2026', active: true, startsAt: null, endsAt: null,
      maxRedemptions: null, onboardingDays: 14, onboardingPlan: 'enterprise',
      onboardingLimits: {}, runwayPlan: 'scale', runwayLimits: {},
    };
    const tx = {
      referralRedemption: {
        findUnique: async () => null,
        create: async ({ data }) => data,
      },
      referralCampaign: {
        findUnique: async () => campaign,
        updateMany: async () => ({ count: 1 }),
      },
      organizationEntitlement: {
        deleteMany: async () => ({}), updateMany: async () => ({}), createMany: async () => ({}),
      },
      organization: { update: async () => ({}) },
    };
    const result = await claimReferralOffer({
      tx, orgId: 'org-id', userId: 'user-id', offer: buildReferralOffer(campaign),
    });
    assert.equal(result.onboardingPlan, 'enterprise');
    assert.equal(result.runwayPlan, 'scale');
  });

  it('records cumulative memory usage without any decrement path', async () => {
    const statements = [];
    const tracker = new UsageTracker({
      $executeRawUnsafe: async (sql) => { statements.push(sql); },
    });
    await tracker.recordMemory('11111111-1111-4111-8111-111111111111');
    assert.equal(statements.length, 2);
    assert.match(statements[1], /org_usage_cumulative/);
    assert.match(statements[1], /\+ \$2/);
    assert.doesNotMatch(statements[1], /DELETE|-/i);
  });

});

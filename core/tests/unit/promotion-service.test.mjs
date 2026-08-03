import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  digestPromotionValue,
  getEffectivePromotionEntitlement,
  normalizeAccountProfile,
  normalizePromotionCode,
  normalizePromotionInput,
  promotionCodeHint,
} from '../../src/billing/promotion-service.js';

describe('PromotionService normalization', () => {
  it('normalizes codes while retaining only an irreversible digest and short hint', () => {
    const code = normalizePromotionCode(' legal-pilot_26 ');
    const digest = digestPromotionValue(code);
    assert.equal(code, 'LEGAL-PILOT_26');
    assert.equal(digest.length, 64);
    assert.notEqual(digest, code);
    assert.equal(promotionCodeHint(code), 'LEGA...');
  });

  it('enforces compatible commercial account and storage profiles', () => {
    assert.deepEqual(normalizeAccountProfile({ accountType: 'personal' }), {
      accountType: 'personal', hostingMode: 'managed', storageMode: 'amr_embedded',
    });
    assert.deepEqual(normalizeAccountProfile({ accountType: 'enterprise_self_hosted' }), {
      accountType: 'enterprise_self_hosted', hostingMode: 'self_host', storageMode: 'byod_amr',
    });
    assert.throws(() => normalizeAccountProfile({ accountType: 'personal', storageMode: 'hybrid' }), /invalid account type and storage combination/);
  });

  it('keeps target eligibility hashed and validates the Stripe offer shape', () => {
    const promotion = normalizePromotionInput({
      internal_name: 'Legal pilot', code: 'LEGAL26', base_plan: 'enterprise',
      account_type: 'enterprise_managed', storage_mode: 'hybrid', billing_mode: 'stripe_discount',
      commercial_terms: { kind: 'percentage_discount', percent_off: 20 },
      eligibilities: [{ type: 'email', value: 'owner@example.com' }],
      max_redemptions: 4,
    });
    assert.equal(promotion.codeHash.length, 64);
    assert.equal(promotion.eligibilities[0].valueHash.length, 64);
    assert.notEqual(promotion.eligibilities[0].valueHash, 'owner@example.com');
    assert.equal(promotion.eligibilities[0].valueHint, 'ow***@example.com');
    assert.throws(() => normalizePromotionInput({
      internal_name: 'Broken offer', code: 'BROKEN', base_plan: 'pro', account_type: 'personal',
      billing_mode: 'stripe_discount', commercial_terms: { kind: 'trial', trial_days: 14 },
    }), /Stripe promotions require a discount offer/);
  });

  it('requires material offers to use a new valid version shape', () => {
    assert.throws(() => normalizePromotionInput({
      internal_name: 'Expired', code: 'EXPIRED', base_plan: 'pro', account_type: 'personal',
      starts_at: '2026-08-10T00:00:00Z', ends_at: '2026-08-09T00:00:00Z',
    }), /expiry must be after start date/);
  });

  it('moves expired pilots to manual review without changing their history', async () => {
    const expiredAt = new Date('2026-08-01T00:00:00.000Z');
    const result = await getEffectivePromotionEntitlement({
      entitlementGrant: { findFirst: async () => ({ id: 'grant-id', status: 'active', startsAt: new Date('2026-07-01T00:00:00.000Z'), endsAt: expiredAt, fallbackAction: 'manual_review' }) },
    }, 'org-id', new Date('2026-08-02T00:00:00.000Z'));
    assert.equal(result.status, 'manual_review');
    assert.equal(result.grant.id, 'grant-id');
  });

  it('keeps a suspended or revoked grant authoritative over legacy plan projections', async () => {
    for (const status of ['suspended', 'revoked']) {
      const result = await getEffectivePromotionEntitlement({
        entitlementGrant: { findFirst: async () => ({ id: `${status}-grant`, status, startsAt: new Date('2026-07-01T00:00:00.000Z'), endsAt: null, fallbackAction: 'manual_review' }) },
      }, 'org-id', new Date('2026-08-02T00:00:00.000Z'));
      assert.equal(result.status, status);
      assert.equal(result.version, null);
    }
  });
});

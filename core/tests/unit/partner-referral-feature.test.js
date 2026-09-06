import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partnerReferralsEnabled, resetPartnerReferralFlagCache } from '../../src/billing/partner-referral-feature.js';

test('partner referrals are controlled only by Flagship and fail closed', async () => {
  resetPartnerReferralFlagCache();
  const disabled = await partnerReferralsEnabled({
    PARTNER_REFERRALS_ENABLED: 'true',
    CLOUDFLARE_FEATURE_FLAGS_URL: 'https://flags.test/partner-referrals',
  }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ key: 'partner_referrals_v1', enabled: false, source: 'cloudflare-flagship' }) }),
  });
  assert.equal(disabled, false);

  resetPartnerReferralFlagCache();
  const enabled = await partnerReferralsEnabled({
    PARTNER_REFERRALS_ENABLED: 'false',
    CLOUDFLARE_FEATURE_FLAGS_URL: 'https://flags.test/partner-referrals',
  }, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ key: 'partner_referrals_v1', enabled: true, source: 'cloudflare-flagship' }) }),
  });
  assert.equal(enabled, true);

  resetPartnerReferralFlagCache();
  const unavailable = await partnerReferralsEnabled({}, { fetchImpl: async () => ({ ok: false }) });
  assert.equal(unavailable, false);
});

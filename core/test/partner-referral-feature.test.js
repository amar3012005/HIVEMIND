import test from 'node:test';
import assert from 'node:assert/strict';

import {
  partnerReferralsEnabled,
  resetPartnerReferralFlagCache,
} from '../src/billing/partner-referral-feature.js';

test.beforeEach(() => resetPartnerReferralFlagCache());

test('partner referrals default to disabled without consulting Cloudflare', async () => {
  let calls = 0;
  const enabled = await partnerReferralsEnabled({}, { fetchImpl: async () => { calls += 1; } });
  assert.equal(enabled, false);
  assert.equal(calls, 0);
});

test('partner referrals require both the master switch and Flagship', async () => {
  const on = async () => new Response(JSON.stringify({
    key: 'partner_referrals_v1',
    enabled: true,
    source: 'cloudflare-flagship',
  }), { status: 200 });

  assert.equal(await partnerReferralsEnabled({ PARTNER_REFERRALS_ENABLED: ' TRUE ' }, { fetchImpl: on }), true);
  resetPartnerReferralFlagCache();
  assert.equal(await partnerReferralsEnabled({ PARTNER_REFERRALS_ENABLED: '1' }, { fetchImpl: on }), false);
  assert.equal(await partnerReferralsEnabled({ PARTNER_REFERRALS_ENABLED: 'yes' }, { fetchImpl: on }), false);
});

test('partner referrals fail closed on invalid or unavailable Flagship responses', async () => {
  const env = { PARTNER_REFERRALS_ENABLED: 'true' };
  assert.equal(await partnerReferralsEnabled(env, {
    fetchImpl: async () => new Response('{"enabled":true}', { status: 200 }),
  }), false);

  resetPartnerReferralFlagCache();
  assert.equal(await partnerReferralsEnabled(env, {
    fetchImpl: async () => { throw new Error('offline'); },
  }), false);
});

test('partner referrals cache the Flagship evaluation briefly', async () => {
  let calls = 0;
  const env = { PARTNER_REFERRALS_ENABLED: 'true', PARTNER_REFERRALS_FLAG_CACHE_MS: '5000' };
  const fetchImpl = async () => {
    calls += 1;
    return new Response(JSON.stringify({
      key: 'partner_referrals_v1',
      enabled: true,
      source: 'cloudflare-flagship',
    }), { status: 200 });
  };

  assert.equal(await partnerReferralsEnabled(env, { fetchImpl, now: () => 1000 }), true);
  assert.equal(await partnerReferralsEnabled(env, { fetchImpl, now: () => 2000 }), true);
  assert.equal(calls, 1);
});

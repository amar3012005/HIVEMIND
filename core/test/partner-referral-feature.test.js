import test from 'node:test';
import assert from 'node:assert/strict';

import { partnerReferralsEnabled } from '../src/billing/partner-referral-feature.js';

test('partner referrals default to disabled', () => {
  assert.equal(partnerReferralsEnabled({}), false);
});

test('partner referrals require an explicit true value', () => {
  assert.equal(partnerReferralsEnabled({ PARTNER_REFERRALS_ENABLED: 'true' }), true);
  assert.equal(partnerReferralsEnabled({ PARTNER_REFERRALS_ENABLED: ' TRUE ' }), true);
  assert.equal(partnerReferralsEnabled({ PARTNER_REFERRALS_ENABLED: '1' }), false);
  assert.equal(partnerReferralsEnabled({ PARTNER_REFERRALS_ENABLED: 'yes' }), false);
});

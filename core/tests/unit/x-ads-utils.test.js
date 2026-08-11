import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  amountToMicros, createConfirmation, inclusiveCampaignDays, inclusiveEndAt,
  normalizeTargets, validateDestinationUrl, validatePostText, verifyConfirmation,
} from '../../src/x-ads/utils.js';
import {
  calculateMetrics, createOrganicPost, deleteOrganicPost, getCampaign, listCampaigns,
  normalizeFundingInstrument, normalizeServiceError, reconciledCampaignStatus,
  validateOrganicPostText, xAdsBetaEnabled,
} from '../../src/x-ads/service.js';
import { ProviderError } from '../../src/x-ads/x-api-client.js';

test('amountToMicros converts local currency without floating point math', () => {
  assert.equal(amountToMicros('12.34', 'EUR'), 12_340_000n);
  assert.equal(amountToMicros('100', 'JPY'), 100_000_000n);
  assert.throws(() => amountToMicros('1.5', 'JPY'), /fractional/);
  assert.throws(() => amountToMicros('-2', 'EUR'), /positive/);
});

test('inclusive campaign days use the advertiser local calendar', () => {
  const now = new Date('2026-07-25T23:30:00Z');
  assert.equal(inclusiveCampaignDays('2026-07-27', 'Europe/Berlin', now), 2);
  assert.throws(() => inclusiveCampaignDays('2026-07-25', 'Europe/Berlin', now), /today or later/);
  assert.throws(() => inclusiveCampaignDays('2026-02-31', 'UTC', new Date('2026-02-01T12:00:00Z')), /valid calendar date/);
});

test('inclusive end timestamp lands at advertiser end of day across DST', () => {
  assert.equal(inclusiveEndAt('2026-07-25', 'Europe/Berlin').toISOString(), '2026-07-25T21:59:59.000Z');
  assert.equal(inclusiveEndAt('2026-12-25', 'Europe/Berlin').toISOString(), '2026-12-25T22:59:59.000Z');
});

test('creative validation requires HTTPS and exactly the selected destination', () => {
  const url = validateDestinationUrl('https://example.com/offer');
  assert.equal(validatePostText('See this https://example.com/offer', url), 'See this https://example.com/offer');
  assert.throws(() => validateDestinationUrl('http://example.com'), /HTTPS/);
  assert.throws(() => validatePostText('No link here', url), /exactly one/);
  assert.throws(() => validatePostText('https://other.example/path', url), /must match/);
  assert.throws(
    () => validatePostText('See https://example.com/offer?source=other', 'https://example.com/offer?source=campaign'),
    /must match/,
  );
});

test('target normalization deduplicates opaque X values', () => {
  assert.deepEqual(normalizeTargets([
    { name: 'Berlin', targeting_value: 'abc' },
    { name: 'Berlin duplicate', targeting_value: 'abc' },
  ], 'LOCATION'), [{ name: 'Berlin duplicate', targeting_type: 'LOCATION', targeting_value: 'abc' }]);
});

test('confirmation token is bound to campaign payload and version', () => {
  const oldSecret = process.env.X_ADS_CONFIRMATION_SECRET;
  process.env.X_ADS_CONFIRMATION_SECRET = 'test-confirmation-secret';
  const campaign = {
    id: '11111111-1111-4111-8111-111111111111', draftVersion: 2,
    xUserId: '42', adAccountId: 'acct', fundingInstrumentId: 'fund', name: 'Launch',
    destinationUrl: 'https://example.com', postText: 'Visit https://example.com', imageData: null,
    locationTargets: [{ targeting_value: 'loc' }], languageTargets: [{ targeting_value: 'en' }],
    dailyBudgetMicros: 10_000_000n, totalBudgetMicros: 30_000_000n,
    currency: 'EUR', accountTimezone: 'Europe/Berlin', endDate: '2026-07-27',
  };
  const confirmation = createConfirmation(campaign);
  campaign.confirmationHash = confirmation.hash;
  campaign.confirmationExpiresAt = confirmation.expiresAt;
  assert.equal(verifyConfirmation(campaign, confirmation.token), true);
  assert.equal(verifyConfirmation({ ...campaign, draftVersion: 3 }, confirmation.token), false);
  if (oldSecret === undefined) delete process.env.X_ADS_CONFIRMATION_SECRET;
  else process.env.X_ADS_CONFIRMATION_SECRET = oldSecret;
});

test('beta gate requires both master flag and org allowlist', () => {
  assert.equal(xAdsBetaEnabled('org-a', { X_ADS_ENABLED: 'true', X_ADS_BETA_ORG_IDS: 'org-a,org-b' }), true);
  assert.equal(xAdsBetaEnabled('org-c', { X_ADS_ENABLED: 'true', X_ADS_BETA_ORG_IDS: 'org-a' }), false);
  assert.equal(xAdsBetaEnabled('org-a', { X_ADS_ENABLED: 'false', X_ADS_BETA_ORG_IDS: '*' }), false);
});

test('ordinary X Post validation trims input and enforces the public Post limit', () => {
  assert.equal(validateOrganicPostText('  Launch update  '), 'Launch update');
  assert.equal(Array.from(validateOrganicPostText('🚀'.repeat(280))).length, 280);
  assert.throws(() => validateOrganicPostText('   '), { code: 'post_text_required' });
  assert.throws(() => validateOrganicPostText('x'.repeat(281)), { code: 'post_text_too_long' });
});

test('ordinary X Post writes require explicit confirmation before credential lookup', async () => {
  const previousEnabled = process.env.X_ADS_ENABLED;
  const previousOrgs = process.env.X_ADS_BETA_ORG_IDS;
  process.env.X_ADS_ENABLED = 'true'; process.env.X_ADS_BETA_ORG_IDS = 'org-a';
  const prisma = { xAdsCredential: { findFirst: async () => assert.fail('credential lookup should not run') } };
  await assert.rejects(
    createOrganicPost({ prisma, orgId: 'org-a', userId: 'user-a', text: 'Test', confirmed: false }),
    { code: 'confirmation_required' },
  );
  await assert.rejects(
    deleteOrganicPost({ prisma, orgId: 'org-a', userId: 'user-a', postId: '123', confirmed: false }),
    { code: 'confirmation_required' },
  );
  if (previousEnabled === undefined) delete process.env.X_ADS_ENABLED; else process.env.X_ADS_ENABLED = previousEnabled;
  if (previousOrgs === undefined) delete process.env.X_ADS_BETA_ORG_IDS; else process.env.X_ADS_BETA_ORG_IDS = previousOrgs;
});

test('funding instruments use X able-to-fund fields', () => {
  const active = normalizeFundingInstrument({
    id: 'fi-1', currency: 'USD', type: 'CREDIT_LINE', able_to_fund: true,
    paused: false, cancelled: false, deleted: false,
  }, new Date('2026-07-25T00:00:00Z'));
  assert.equal(active.eligible, true);
  assert.equal(active.status, 'ACTIVE');
  assert.equal(normalizeFundingInstrument({ ...active, id: 'fi-2', paused: true }).eligible, false);
  assert.equal(normalizeFundingInstrument({ ...active, id: 'fi-3', end_time: '2026-07-24T00:00:00Z' }, new Date('2026-07-25T00:00:00Z')).eligible, false);
});

test('analytics totals and derived link metrics are deterministic', () => {
  assert.deepEqual(calculateMetrics([{ id_data: [{ metrics: {
    impressions: [100, 50], url_clicks: [4, 2], billed_charge_local_micro: [1_000_000, 500_000],
  } }] }]), {
    impressions: 150, url_clicks: 6, spend_micros: '1500000',
    click_through_rate: 0.04, cost_per_link_click_micros: '250000',
  });
});

test('X provider errors preserve rate-limit reset without leaking credentials', () => {
  const normalized = normalizeServiceError(new ProviderError('Rate limited', {
    status: 429, code: 'rate_limited', providerStatus: 429, rateReset: '1785000000',
  }));
  assert.deepEqual(normalized, { status: 429, body: {
    error: 'rate_limited', message: 'Rate limited', provider_status: 429, retry_at: '1785000000',
  } });
});

test('X delivery state reconciliation prioritizes rejection and completion', () => {
  assert.equal(reconciledCampaignStatus({ currentStatus: 'ACTIVE', approval: 'REJECTED' }), 'REJECTED');
  assert.equal(reconciledCampaignStatus({ currentStatus: 'ACTIVE', effectiveStatus: 'EXPIRED' }), 'COMPLETED');
  assert.equal(reconciledCampaignStatus({
    currentStatus: 'ACTIVE', endAt: new Date('2026-07-24T23:59:59Z'), now: new Date('2026-07-25T00:00:00Z'),
  }), 'COMPLETED');
  assert.equal(reconciledCampaignStatus({ currentStatus: 'PAUSED', effectiveStatus: 'PAUSED' }), 'PAUSED');
});

test('campaign reads always include the authenticated organization and user scope', async () => {
  const previousEnabled = process.env.X_ADS_ENABLED;
  const previousOrgs = process.env.X_ADS_BETA_ORG_IDS;
  process.env.X_ADS_ENABLED = 'true'; process.env.X_ADS_BETA_ORG_IDS = 'org-a';
  const calls = [];
  const row = {
    id: 'campaign-a', orgId: 'org-a', name: 'Test', status: 'DRAFT', draftVersion: 1,
    destinationUrl: 'https://example.com/', postText: 'Visit https://example.com/',
    locationTargets: [], languageTargets: [], xSnapshot: {}, metrics: {}, steps: [],
  };
  const prisma = { xAdsCampaign: {
    findMany: async (args) => { calls.push(args.where); return [row]; },
    findFirst: async (args) => { calls.push(args.where); return row; },
  } };
  await listCampaigns({ prisma, orgId: 'org-a', userId: 'user-a' });
  await getCampaign({ prisma, orgId: 'org-a', userId: 'user-a', id: 'campaign-a' });
  assert.deepEqual(calls, [{ orgId: 'org-a', userId: 'user-a' }, { id: 'campaign-a', orgId: 'org-a', userId: 'user-a' }]);
  if (previousEnabled === undefined) delete process.env.X_ADS_ENABLED; else process.env.X_ADS_ENABLED = previousEnabled;
  if (previousOrgs === undefined) delete process.env.X_ADS_BETA_ORG_IDS; else process.env.X_ADS_BETA_ORG_IDS = previousOrgs;
});

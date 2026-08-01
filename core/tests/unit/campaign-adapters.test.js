import test from 'node:test';
import assert from 'node:assert/strict';

import { gmailAdapter } from '../../src/campaigns/adapters/gmail.js';
import { taraAdapter } from '../../src/campaigns/adapters/tara.js';
import { xOrganicAdapter } from '../../src/campaigns/adapters/x-organic.js';
import { __test as zernioTest, createZernioSocialAdapter } from '../../src/campaigns/adapters/zernio-social.js';
import { createZernioAdsAdapter } from '../../src/campaigns/adapters/zernio-ads.js';
import { __test as zernioExecutionTest } from '../../src/campaigns/zernio-execution.js';
import { assertCampaignAdapter } from '../../src/campaigns/adapters/contract.js';

const campaign = { id: 'campaign-a', orgId: 'org-a', ownerUserId: 'user-a', roomId: 'room-a', name: 'Pilot', goal: 'Launch' };
const approval = { id: 'approval-a', campaignId: 'campaign-a', planVersionId: 'plan-a', status: 'ACTIVE', channels: ['x_organic', 'gmail', 'tara'] };
const action = (channel, payload) => ({ id: `action-${channel}`, campaignId: campaign.id, planVersionId: 'plan-a', channel, payload, campaign, scheduledAt: new Date() });

test('X adapter executes only the approval-bound final text', async () => {
  let request;
  const result = await xOrganicAdapter.execute({
    prisma: {}, action: action('x_organic', { text: 'Approved post' }), approval,
    providers: { async createOrganicPost(value) { request = value; return { id: '123', text: value.text }; } },
  });
  assert.equal(request.text, 'Approved post');
  assert.equal(request.confirmed, true);
  assert.equal(result.externalId, '123');
});

test('adapter contract requires capability, validation, execution, pause, reconciliation, and metrics', () => {
  assert.equal(assertCampaignAdapter(xOrganicAdapter), xOrganicAdapter);
  assert.throws(() => assertCampaignAdapter({ channel: 'broken', execute() {}, reconcile() {} }), /checkCapability/);
});

test('X adapter normalizes owned Post metrics without exposing credentials', async () => {
  const requests = [];
  const metrics = await xOrganicAdapter.syncMetrics({
    prisma: {}, action: { ...action('x_organic', { text: 'Approved post' }), externalId: '123' },
    providers: { async directXRequest(request) {
      requests.push(request.path);
      if (request.path.startsWith('/2/tweets/')) return { data: { data: { public_metrics: { like_count: 4, reply_count: 2, retweet_count: 1, quote_count: 1, bookmark_count: 2 }, organic_metrics: { impression_count: 100, url_link_clicks: 5 } } } };
      return { data: { data: { public_metrics: { followers_count: 42 } } } };
    } },
  });
  assert.equal(requests.length, 2); assert.equal(metrics.impressions, 100); assert.equal(metrics.engagements, 15);
  assert.equal(metrics.engagement_rate, 0.15); assert.equal(metrics.followers, 42);
});

test('generic social adapter publishes through the organization-owned Zernio account', async () => {
  const account = zernioExecutionTest.normalizeAccount({ _id: 'provider-linkedin-a', platform: 'linkedin', isActive: true, canPost: true }, 'org-a');
  const linkedin = createZernioSocialAdapter('linkedin');
  let request;
  const result = await linkedin.execute({
    prisma: { zernioOrgProfile: { async findUnique() { return { orgId: 'org-a', connectedAccounts: [account] }; } } },
    action: action('linkedin', { text: 'Approved LinkedIn post' }),
    approval: { ...approval, channels: [...approval.channels, 'linkedin'] },
    providers: { async requestZernio(path, options) { request = { path, options }; return { post: { _id: 'post-a', status: 'published' } }; } },
  });
  assert.equal(request.path, '/posts');
  assert.equal(request.options.requestId, 'action-linkedin');
  assert.deepEqual(request.options.body.platforms, [{ platform: 'linkedin', accountId: 'provider-linkedin-a' }]);
  assert.equal(result.externalId, 'post-a');
  assert.equal(JSON.stringify(result).includes('provider-linkedin-a'), false);
});

test('generic social metrics expose only the stable campaign metric contract', () => {
  assert.deepEqual(zernioTest.normalizedMetrics({
    impressions: 100, engagements: 12, urlClicks: 5, likes: 4, replies: 2,
    reposts: 1, accessToken: 'must-not-leak', accountId: 'provider-account',
  }), {
    impressions: 100, engagements: 12, clicks: 5, likes: 4, comments: 2,
    shares: 1, follows: 0, engagement_rate: 0.12, click_through_rate: 0.05,
  });
});

test('empty Zernio profile preserves native X execution and provider-bound metrics', async () => {
  const fallbackCalls = [];
  const fallback = {
    async checkCapability() { fallbackCalls.push('capability'); return { connected: true }; },
    validateAction() { return { valid: true }; },
    async execute() { fallbackCalls.push('execute'); return { externalId: '12345', response: { provider: 'native_x' } }; },
    async reconcile() { fallbackCalls.push('reconcile'); return { status: 'SUCCEEDED', externalId: '12345' }; },
    async pause() { return { status: 'PAUSED' }; },
    async captureBaseline() { fallbackCalls.push('baseline'); return { followers: 10 }; },
    async syncMetrics() { fallbackCalls.push('metrics'); return { impressions: 20 }; },
  };
  const adapter = createZernioSocialAdapter('x_organic', { fallback });
  const prisma = {
    zernioOrgProfile: { async findUnique() { return { orgId: 'org-a', connectedAccounts: [] }; } },
    campaignActionAttempt: { async findFirst() { return { response: { provider: 'native_x' } }; } },
  };
  const nativeAction = { ...action('x_organic', { text: 'Approved post' }), externalId: '12345' };
  await adapter.checkCapability({ prisma, action: nativeAction });
  await adapter.execute({ prisma, action: nativeAction, approval });
  await adapter.reconcile({ prisma, action: nativeAction });
  await adapter.captureBaseline({ prisma, campaign });
  const metrics = await adapter.syncMetrics({ prisma, action: nativeAction });
  assert.deepEqual(metrics, { impressions: 20 });
  assert.deepEqual(fallbackCalls, ['capability', 'execute', 'reconcile', 'baseline', 'metrics']);
});

test('paid adapter resolves an advertiser account and creates one approval-bound ad idempotently', async () => {
  const restoreKey = process.env.ZERNIO_API_KEY;
  process.env.ZERNIO_API_KEY = 'server-only-test-key';
  const account = zernioExecutionTest.normalizeAccount({ _id: 'provider-xads-a', platform: 'xads', isActive: true }, 'org-a');
  const xAds = createZernioAdsAdapter('x_ads');
  let createRequest;
  const paidAction = {
    ...action('x_ads', { text: 'A concise approved ad', goal: 'awareness', destination_url: 'https://example.com', targeting: { countries: ['FR'] } }),
    campaign: { ...campaign, objective: 'AWARENESS', brief: { destination_url: 'https://example.com' } },
  };
  try {
    const result = await xAds.execute({
      prisma: {
        zernioOrgProfile: { async findUnique() { return { orgId: 'org-a', connectedAccounts: [account] }; } },
        campaignPlanVersion: { async findUnique() { return { bundle: { media_plan: { currency: 'EUR', channels: [{ channel: 'x_ads', budget_amount: 20 }] } } }; } },
      },
      action: paidAction,
      approval: { ...approval, channels: [...approval.channels, 'x_ads'] },
      providers: {
        async fetch() { return { ok: true, status: 200, headers: { get: () => null }, async text() { return JSON.stringify({ accounts: [{ id: '18ce54d4x5t', name: 'Pilot', currency: 'EUR', selectable: true }] }); } }; },
        async requestZernio(path, options) { createRequest = { path, options }; return { ad: { _id: 'ad-a', status: 'in_review' } }; },
      },
    });
    assert.equal(createRequest.path, '/ads/create');
    assert.equal(createRequest.options.idempotencyKey, 'action-x_ads');
    assert.equal(createRequest.options.body.accountId, 'provider-xads-a');
    assert.equal(createRequest.options.body.adAccountId, '18ce54d4x5t');
    assert.equal(createRequest.options.body.budgetAmount, 20);
    assert.equal(result.externalId, 'ad-a');
    assert.equal(JSON.stringify(result).includes('provider-xads-a'), false);
  } finally {
    if (restoreKey === undefined) delete process.env.ZERNIO_API_KEY; else process.env.ZERNIO_API_KEY = restoreKey;
  }
});

test('Gmail adapter writes the outbound ledger and deduplicates a repeated action', async () => {
  const rows = []; let sends = 0;
  const prisma = {
    outboundAction: {
      async count() { return 0; },
      async findFirst({ where }) { return rows.find((row) => row.campaignActionId === where.campaignActionId && row.status === 'sent') || null; },
      async create({ data }) { rows.push(data); return data; },
    },
  };
  const context = {
    prisma, action: action('gmail', { to: 'Lead@Example.com', subject: 'Hello', body: 'Approved body' }), approval,
    providers: { async runGoogleTool() { sends += 1; return { id: 'msg-1', threadId: 'thread-1', access_token: 'must-not-leak' }; } },
  };
  const first = await gmailAdapter.execute(context);
  const second = await gmailAdapter.execute(context);
  assert.equal(sends, 1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].approvalId, approval.id);
  assert.equal(rows[0].recipient, 'lead@example.com');
  assert.equal(first.response.access_token, undefined);
  assert.equal(second.response.deduplicated, true);
});

test('TARA adapter closes a DNC-denied attempt without calling the provider', async () => {
  const statuses = []; let providerCalls = 0;
  const attempt = { id: 'attempt-a', status: 'queued', callLegId: null, sessionId: null };
  const prisma = {
    taraRuntimeConfig: { async findUnique() { return { defaultProvider: 'deepgram', revision: 1 }; } },
    taraCampaign: {
      async findFirst() { return null; },
      async upsert() { return { id: 'tara-campaign-a', orgId: 'org-a', callingWindow: { days: [1, 2, 3, 4, 5], startHour: 9, endHour: 20 }, caps: { concurrency: 1 }, complianceConfig: {} }; },
    },
    taraCampaignContact: {
      async upsert() { return { id: 'contact-a', phone: '+353123456789', country: 'IE', timezone: 'Europe/Dublin', lawfulBasis: 'consent' }; },
      async update() { return {}; },
    },
    taraCallAttempt: {
      async upsert() { return attempt; },
      async count() { return 0; },
      async update({ data }) { Object.assign(attempt, data); statuses.push(data.status); return { ...attempt }; },
    },
    dncList: { async findMany() { return [{ phone: '+353123456789' }]; } },
  };
  await assert.rejects(() => taraAdapter.execute({
    prisma,
    action: action('tara', { to: '+353123456789', opening: 'Hello', lawful_basis: 'consent', country: 'IE', timezone: 'Europe/Dublin' }),
    approval,
    providers: { now: new Date('2026-07-27T10:00:00Z'), async fetch() { providerCalls += 1; throw new Error('must not dial'); } },
  }), { code: 'tara_gate_dnc', outcome: 'BLOCKED' });
  assert.deepEqual(statuses, ['gated', 'skipped']);
  assert.equal(providerCalls, 0);
});

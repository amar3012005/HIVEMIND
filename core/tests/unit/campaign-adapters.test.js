import test from 'node:test';
import assert from 'node:assert/strict';

import { gmailAdapter } from '../../src/campaigns/adapters/gmail.js';
import { taraAdapter } from '../../src/campaigns/adapters/tara.js';
import { xOrganicAdapter } from '../../src/campaigns/adapters/x-organic.js';
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

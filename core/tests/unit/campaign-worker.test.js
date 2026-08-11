import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalHash } from '../../src/campaigns/service.js';
import { processDueCampaignActions, quarantineExpiredCampaignLeases } from '../../src/campaigns/worker.js';

function workerPrisma({ providerError = null } = {}) {
  const payload = { text: 'Approved text' };
  const action = {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', campaignId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    planVersionId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', channel: 'x_organic', payload,
    campaign: { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', orgId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', ownerUserId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee' },
    attempts: [], status: 'QUEUED',
  };
  let leased = false; const attempts = []; const events = [];
  const prisma = {
    async $queryRawUnsafe(sql) { if (String(sql).includes("status = 'NEEDS_RECONCILIATION'")) return []; if (leased || action.status !== 'QUEUED') return []; leased = true; action.status = 'EXECUTING'; return [{ id: action.id }]; },
    async $transaction(values) { return Promise.all(values); },
    campaignAction: {
      async findUnique() { return { ...action, attempts: [...attempts].reverse().slice(0, 1) }; },
      async update({ data }) { Object.assign(action, data); return action; },
      async count({ where }) {
        if (where.status?.notIn) return where.status.notIn.includes(action.status) ? 0 : 1;
        return where.status?.in?.includes(action.status) ? 1 : 0;
      },
    },
    campaignActionAttempt: {
      async create({ data }) { const row = { id: `attempt-${attempts.length + 1}`, status: 'RUNNING', ...data }; attempts.push(row); return row; },
      async update({ where, data }) { const row = attempts.find((item) => item.id === where.id); Object.assign(row, data); return row; },
    },
    campaignApproval: { async findFirst() { return { id: 'approval-a', campaignId: action.campaignId, planVersionId: action.planVersionId, status: 'ACTIVE', channels: ['x_organic'], caps: { action_hashes: { [action.id]: canonicalHash(payload) } } }; } },
    xAdsCredential: { async findUnique() { return { status: 'active' }; } },
    campaign: { async update({ data }) { return { ...action.campaign, ...data }; } },
    campaignChannel: { async updateMany() { return { count: 1 }; } },
    campaignEvent: { async create({ data }) { events.push(data); return data; } },
  };
  const providers = { async createOrganicPost() { if (providerError) throw providerError; return { id: '12345', text: payload.text }; } };
  return { prisma, providers, action, attempts, events };
}

test('worker leases and publishes one approval-bound action exactly once', async () => {
  const oldWorker = process.env.CAMPAIGNS_V2_WORKER_ENABLED; const oldChannels = process.env.CAMPAIGNS_V2_EXECUTION_CHANNELS;
  process.env.CAMPAIGNS_V2_WORKER_ENABLED = 'true'; process.env.CAMPAIGNS_V2_EXECUTION_CHANNELS = 'x_organic';
  try {
    const state = workerPrisma();
    const first = await processDueCampaignActions({ prisma: state.prisma, providers: state.providers, limit: 5 });
    const second = await processDueCampaignActions({ prisma: state.prisma, providers: state.providers, limit: 5 });
    assert.equal(first.processed, 1); assert.equal(second.processed, 0);
    assert.equal(state.action.status, 'SUCCEEDED'); assert.equal(state.action.externalId, '12345');
    assert.equal(state.attempts.length, 1);
  } finally {
    if (oldWorker === undefined) delete process.env.CAMPAIGNS_V2_WORKER_ENABLED; else process.env.CAMPAIGNS_V2_WORKER_ENABLED = oldWorker;
    if (oldChannels === undefined) delete process.env.CAMPAIGNS_V2_EXECUTION_CHANNELS; else process.env.CAMPAIGNS_V2_EXECUTION_CHANNELS = oldChannels;
  }
});

test('expired executing leases are quarantined instead of replayed', async () => {
  const attempts = []; const events = [];
  const prisma = {
    async $queryRawUnsafe() { return [{ id: 'action-a', campaign_id: 'campaign-a' }]; },
    campaign: { async findUnique() { return { orgId: 'org-a' }; }, async update() { return { orgId: 'org-a' }; } },
    campaignAction: { async count({ where }) { return where.status?.notIn ? 0 : 1; } },
    campaignChannel: { async updateMany() { return { count: 1 }; } },
    campaignActionAttempt: { async updateMany({ data }) { attempts.push(data); return { count: 1 }; } },
    campaignEvent: { async create({ data }) { events.push(data); return data; } },
    async $transaction(values) { return Promise.all(values); },
  };
  const result = await quarantineExpiredCampaignLeases(prisma);
  assert.equal(result.quarantined, 1);
  assert.equal(attempts[0].status, 'NEEDS_RECONCILIATION');
  assert.equal(events[0].data.automatic_retry, false);
});

test('ambiguous provider writes stop at reconciliation and are not replayed', async () => {
  const oldWorker = process.env.CAMPAIGNS_V2_WORKER_ENABLED; const oldChannels = process.env.CAMPAIGNS_V2_EXECUTION_CHANNELS;
  process.env.CAMPAIGNS_V2_WORKER_ENABLED = 'true'; process.env.CAMPAIGNS_V2_EXECUTION_CHANNELS = 'x_organic';
  try {
    const error = new Error('provider timeout'); error.name = 'TimeoutError';
    const state = workerPrisma({ providerError: error });
    await processDueCampaignActions({ prisma: state.prisma, providers: state.providers });
    const replay = await processDueCampaignActions({ prisma: state.prisma, providers: state.providers });
    assert.equal(state.action.status, 'NEEDS_RECONCILIATION');
    assert.equal(state.attempts.length, 1); assert.equal(replay.processed, 0);
    assert.equal(state.events.some((event) => event.data?.automatic_retry === false), true);
  } finally {
    if (oldWorker === undefined) delete process.env.CAMPAIGNS_V2_WORKER_ENABLED; else process.env.CAMPAIGNS_V2_WORKER_ENABLED = oldWorker;
    if (oldChannels === undefined) delete process.env.CAMPAIGNS_V2_EXECUTION_CHANNELS; else process.env.CAMPAIGNS_V2_EXECUTION_CHANNELS = oldChannels;
  }
});

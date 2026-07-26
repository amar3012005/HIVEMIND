import test from 'node:test';
import assert from 'node:assert/strict';

import { approveCampaign, buildCampaignLaunchSchedule, canonicalHash } from '../../src/campaigns/service.js';

function withCampaignLaunchFlags(run) {
  return async () => {
    const previous = Object.fromEntries(['CAMPAIGNS_V2_ENABLED', 'CAMPAIGNS_V2_ORG_IDS', 'CAMPAIGNS_V2_WORKER_ENABLED', 'CAMPAIGNS_V2_EXECUTION_CHANNELS'].map((key) => [key, process.env[key]]));
    process.env.CAMPAIGNS_V2_ENABLED = 'true';
    process.env.CAMPAIGNS_V2_ORG_IDS = 'org-a';
    process.env.CAMPAIGNS_V2_WORKER_ENABLED = 'true';
    process.env.CAMPAIGNS_V2_EXECUTION_CHANNELS = '';
    try { await run(); } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  };
}

test('launch schedule anchors offsets to one approval timestamp', () => {
  const launchAt = new Date('2026-07-26T18:00:00.000Z');
  const schedule = buildCampaignLaunchSchedule([
    { id: 'now', channel: 'x_organic', payload: { scheduled_offset_minutes: 0 } },
    { id: 'later', channel: 'x_organic', payload: { scheduled_offset_minutes: 90 } },
  ], launchAt);
  assert.equal(schedule[0].scheduledAt.toISOString(), launchAt.toISOString());
  assert.equal(schedule[1].scheduledAt.toISOString(), '2026-07-26T19:30:00.000Z');
  assert.throws(
    () => buildCampaignLaunchSchedule([{ id: 'bad', payload: { scheduled_offset_minutes: -1 } }], launchAt),
    (error) => error.code === 'campaign_schedule_invalid',
  );
});

test('campaign approval atomically anchors actions and returns a launch summary', withCampaignLaunchFlags(async () => {
  const launchAt = new Date('2026-07-26T18:00:00.000Z');
  const bundle = {
    actions: [
      { id: 'post-now', channel: 'x_organic', payload: { text: 'Now' }, scheduled_offset_minutes: 0 },
      { id: 'post-later', channel: 'x_organic', payload: { text: 'Later' }, scheduled_offset_minutes: 120 },
    ],
  };
  const plan = { id: 'plan-a', canonicalHash: canonicalHash(bundle), bundle };
  const campaign = {
    id: 'campaign-a', orgId: 'org-a', ownerUserId: 'user-a', status: 'READY_FOR_APPROVAL',
    currentPlanVersionId: 'plan-a', requestedChannels: [], autonomyMode: 'APPROVE_PLAN_ONCE', baseline: {}, planVersions: [plan],
  };
  const actions = [
    { id: 'action-now', channel: 'x_organic', position: 0, payload: { text: 'Now', scheduled_offset_minutes: 0 } },
    { id: 'action-later', channel: 'x_organic', position: 1, payload: { text: 'Later', scheduled_offset_minutes: 120 } },
  ];
  const campaignClaims = []; const actionUpdates = []; const approvalCreates = []; const events = [];
  const tx = {
    campaign: { async updateMany(args) { campaignClaims.push(args); return { count: 1 }; } },
    campaignApproval: {
      async updateMany() { return { count: 0 }; },
      async create({ data }) { approvalCreates.push(data); return { id: 'approval-a', recipientCount: data.recipientCount, ...data }; },
    },
    campaignAction: { async updateMany(args) { actionUpdates.push(args); return { count: 1 }; } },
    campaignAudienceMember: { async updateMany() { return { count: 0 }; } },
    campaignChannel: { async updateMany() { return { count: 0 }; } },
    campaignEvent: { async create({ data }) { events.push(data); return data; } },
  };
  const prisma = {
    campaign: { async findFirst() { return campaign; } },
    campaignAction: { async findMany() { return actions; } },
    userOrganization: { async findUnique() { return null; } },
    xAdsCredential: { async findUnique() { return null; } },
    nangoConnection: { async findFirst() { return null; } },
    platformIntegration: { async findFirst() { return null; } },
    taraRuntimeConfig: { async findUnique() { return null; } },
    async $transaction(run) { return run(tx); },
  };

  const result = await approveCampaign({ prisma, orgId: 'org-a', userId: 'user-a', id: 'campaign-a', clock: () => launchAt });

  assert.equal(campaignClaims[0].data.startedAt.toISOString(), launchAt.toISOString());
  assert.equal(approvalCreates[0].approvedAt.toISOString(), launchAt.toISOString());
  assert.equal(actionUpdates.length, 2);
  assert.equal(actionUpdates[0].data.status, 'QUEUED');
  assert.equal(actionUpdates[0].data.scheduledAt.toISOString(), launchAt.toISOString());
  assert.equal(actionUpdates[1].data.scheduledAt.toISOString(), '2026-07-26T20:00:00.000Z');
  assert.equal(result.launch.immediate_action_count, 1);
  assert.equal(result.launch.scheduled_action_count, 1);
  assert.equal(result.launch.schedule[0].immediate, true);
  assert.equal(events[0].data.launched_at, launchAt.toISOString());
  assert.deepEqual(approvalCreates[0].caps.action_hashes, Object.fromEntries(actions.map((action) => [action.id, canonicalHash(action.payload)])));
}));

test('launch transaction rejects an action that can no longer be claimed READY', withCampaignLaunchFlags(async () => {
  const bundle = { actions: [{ id: 'post-now', channel: 'x_organic', payload: { text: 'Now' }, scheduled_offset_minutes: 0 }] };
  const campaign = {
    id: 'campaign-a', orgId: 'org-a', ownerUserId: 'user-a', status: 'READY_FOR_APPROVAL', currentPlanVersionId: 'plan-a',
    requestedChannels: [], autonomyMode: 'APPROVE_PLAN_ONCE', planVersions: [{ id: 'plan-a', bundle, canonicalHash: canonicalHash(bundle) }],
  };
  const action = { id: 'action-now', channel: 'x_organic', position: 0, payload: { text: 'Now', scheduled_offset_minutes: 0 } };
  const tx = {
    campaign: { async updateMany() { return { count: 1 }; } },
    campaignApproval: { async updateMany() { return { count: 0 }; }, async create({ data }) { return { id: 'approval-a', ...data }; } },
    campaignAction: { async updateMany() { return { count: 0 }; } },
  };
  const prisma = {
    campaign: { async findFirst() { return campaign; } }, campaignAction: { async findMany() { return [action]; } },
    xAdsCredential: { async findUnique() { return null; } }, nangoConnection: { async findFirst() { return null; } },
    platformIntegration: { async findFirst() { return null; } }, taraRuntimeConfig: { async findUnique() { return null; } },
    async $transaction(run) { return run(tx); },
  };
  await assert.rejects(
    approveCampaign({ prisma, orgId: 'org-a', userId: 'user-a', id: 'campaign-a', clock: () => new Date('2026-07-26T18:00:00.000Z') }),
    (error) => error.code === 'campaign_action_launch_conflict',
  );
}));

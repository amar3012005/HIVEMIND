import test from 'node:test';
import assert from 'node:assert/strict';

import { canonicalHash, editCampaignAction, regenerateCampaign } from '../../src/campaigns/service.js';

function withCampaignFlag(run) {
  return async () => {
    const oldEnabled = process.env.CAMPAIGNS_V2_ENABLED; const oldOrgs = process.env.CAMPAIGNS_V2_ORG_IDS;
    process.env.CAMPAIGNS_V2_ENABLED = 'true'; process.env.CAMPAIGNS_V2_ORG_IDS = 'org-a';
    try { await run(); } finally {
      if (oldEnabled === undefined) delete process.env.CAMPAIGNS_V2_ENABLED; else process.env.CAMPAIGNS_V2_ENABLED = oldEnabled;
      if (oldOrgs === undefined) delete process.env.CAMPAIGNS_V2_ORG_IDS; else process.env.CAMPAIGNS_V2_ORG_IDS = oldOrgs;
    }
  };
}

function readyBundle() {
  return {
    strategy: 'Launch with one approved post.', audience: { rationale: 'Current followers.' }, content_pillars: ['Proof'],
    kpis: [{ name: 'Reach', target: '100', source: 'X' }],
    actions: [{ id: 'x-1', channel: 'x_organic', title: 'Launch', final_copy: 'Old copy', payload: { text: 'Old copy' }, scheduled_offset_minutes: 0, rationale: 'Launch now' }],
    requirement_coverage: [{ requirement_id: 'goal', action_ids: ['x-1'] }, { requirement_id: 'channel:x_organic', action_ids: ['x-1'] }],
  };
}

test('editing an action creates a new immutable plan and revokes old approval', withCampaignFlag(async () => {
  const bundle = readyBundle(); const createdActions = []; const planUpdates = []; const actionUpdates = []; const approvalUpdates = []; const campaignUpdates = []; const events = [];
  const oldAction = {
    id: 'action-a', campaignId: 'campaign-a', planVersionId: 'plan-a', audienceMemberId: null,
    channel: 'x_organic', actionType: 'POST', position: 0, status: 'READY', scheduledAt: new Date(), expiresAt: null,
    payload: { text: 'Old copy', final_copy: 'Old copy', source_action_id: 'x-1', scheduled_offset_minutes: 0 },
    rationale: 'Launch now', successMetric: 'Reach', idempotencyKey: 'plan:1:action:x-1',
  };
  const campaign = {
    id: 'campaign-a', orgId: 'org-a', ownerUserId: 'user-a', status: 'READY_FOR_APPROVAL', currentPlanVersionId: 'plan-a', approvedPlanVersionId: null,
    requestedChannels: ['x_organic'], requirements: [{ id: 'goal' }, { id: 'channel:x_organic' }],
    planVersions: [{ id: 'plan-a', version: 1, status: 'READY', bundle, canonicalHash: canonicalHash(bundle) }], actions: [oldAction],
  };
  const tx = {
    campaignPlanVersion: {
      async findFirst() { return { version: 1 }; },
      async create({ data }) { return { id: 'plan-b', ...data }; },
      async update({ data }) { planUpdates.push(data); },
    },
    campaignAction: {
      async create({ data }) { createdActions.push(data); return data; },
      async updateMany({ data }) { actionUpdates.push(data); return { count: 1 }; },
    },
    campaignApproval: { async updateMany({ data }) { approvalUpdates.push(data); return { count: 1 }; } },
    campaign: { async update({ data }) { campaignUpdates.push(data); return data; } },
    campaignEvent: { async create({ data }) { events.push(data); return data; } },
  };
  const prisma = {
    campaign: { async findFirst() { return campaign; } },
    campaignAction: { async findMany() { return [oldAction]; } },
    async $transaction(run) { return run(tx); },
  };
  const result = await editCampaignAction({ prisma, orgId: 'org-a', userId: 'user-a', id: 'campaign-a', actionId: 'action-a', body: { final_copy: 'New copy', scheduled_offset_minutes: 15 } });
  assert.equal(result.planVersionId, 'plan-b'); assert.equal(createdActions.length, 1);
  assert.equal(createdActions[0].payload.text, 'New copy'); assert.equal(createdActions[0].planVersionId, 'plan-b');
  assert.equal(planUpdates[0].status, 'SUPERSEDED'); assert.equal(actionUpdates[0].status, 'CANCELLED');
  assert.equal(approvalUpdates[0].status, 'REVOKED'); assert.equal(campaignUpdates[0].approvedPlanVersionId, null);
  assert.equal(events[0].eventType, 'campaign_action_edited');
}));

test('regeneration creates the next turn in the same campaign room', withCampaignFlag(async () => {
  const events = []; const campaignUpdates = []; const runs = []; const turns = [];
  const campaign = {
    id: 'campaign-a', orgId: 'org-a', ownerUserId: 'user-a', roomId: 'room-a', name: 'Launch', goal: 'Launch well', objective: 'AWARENESS',
    status: 'READY_FOR_APPROVAL', currentPlanVersionId: 'plan-a', requestedChannels: ['x_organic'], requirements: [{ id: 'goal' }],
    brief: {}, audiencePolicy: {}, schedulePolicy: {}, autonomyMode: 'APPROVE_PLAN_ONCE',
  };
  const room = { id: 'room-a', goal: 'Campaign room', participantIds: ['agent-a'] };
  const tx = {
    campaign: { async updateMany({ data }) { campaignUpdates.push(data); return { count: 1 }; } },
    hyperTurn: {
      async findFirst() { return { seq: 3 }; },
      async create({ data }) { const row = { id: 'turn-4', ...data }; turns.push(row); return row; },
    },
    campaignRun: { async create({ data }) { const row = { id: 'run-2', ...data }; runs.push(row); return row; } },
    campaignPlanVersion: { async updateMany() { return { count: 1 }; } },
    campaignAction: { async updateMany() { return { count: 1 }; } },
    campaignApproval: { async updateMany() { return { count: 1 }; } },
    campaignChannel: { async updateMany() { return { count: 1 }; } },
    campaignEvent: { async create({ data }) { events.push(data); return data; } },
  };
  const prisma = {
    campaign: { async findFirst() { return campaign; } }, hyperRoom: { async findUnique() { return room; } },
    async $transaction(run) { return run(tx); },
  };
  const result = await regenerateCampaign({ prisma, orgId: 'org-a', userId: 'user-a', id: 'campaign-a', feedback: 'Use stronger evidence.' });
  assert.equal(result.campaignId, 'campaign-a'); assert.equal(result.dispatch.room_id, 'room-a'); assert.equal(result.dispatch.campaign_id, 'campaign-a');
  assert.equal(turns[0].seq, 4); assert.equal(runs[0].turnId, 'turn-4'); assert.equal(campaignUpdates[0].status, 'GENERATING');
  assert.ok(turns[0].idempotencyKey.length <= 64); assert.match(turns[0].idempotencyKey, /^campaign-regen-/);
  assert.equal(events[0].eventType, 'campaign_regeneration_started');
}));

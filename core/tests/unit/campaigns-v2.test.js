import test from 'node:test';
import assert from 'node:assert/strict';

import { campaignAgentWhere, canonicalHash, normalizeCampaignInput, validateCampaignBundle } from '../../src/campaigns/service.js';
import { assertTransition, campaignChannelExecutionEnabled, campaignExecutionChannels, campaignsV2Enabled, campaignWorkerEnabled } from '../../src/campaigns/state.js';
import { buildCampaignKickoff, buildCampaignRoomDispatch, normalizeCampaignRoomEvent } from '../../src/campaigns/contracts.js';
import { handleCampaignDispatchError, handleCampaignRoomEvent } from '../../src/campaigns/pipeline.js';

const baseInput = {
  idempotency_key: 'create-1', objective: 'LEAD_GENERATION',
  goal: 'Generate qualified conversations for the new product launch.',
  channels: ['x_organic'], duration_days: 14, timezone: 'Europe/Berlin',
};

test('campaign input requires caller idempotency and validates time boundaries', () => {
  assert.equal(normalizeCampaignInput(baseInput).creationKey, 'create-1');
  assert.throws(() => normalizeCampaignInput({ ...baseInput, idempotency_key: '' }), { code: 'idempotency_key_required' });
  assert.throws(() => normalizeCampaignInput({ ...baseInput, duration_days: 0 }), { code: 'invalid_duration' });
  assert.throws(() => normalizeCampaignInput({ ...baseInput, timezone: 'Mars/Olympus' }), { code: 'invalid_timezone' });
  assert.throws(() => normalizeCampaignInput({ ...baseInput, destination_url: 'javascript:alert(1)' }), { code: 'invalid_destination_url' });
});

test('campaign input rejects roadmap-only channels', () => {
  assert.throws(() => normalizeCampaignInput({ ...baseInput, channels: ['linkedin'] }), { code: 'channel_not_executable' });
});

test('canonical campaign hash is stable across object key order', () => {
  assert.equal(canonicalHash({ b: 2, a: { d: 4, c: 3 } }), canonicalHash({ a: { c: 3, d: 4 }, b: 2 }));
  assert.notEqual(canonicalHash({ a: 1 }), canonicalHash({ a: 2 }));
});

test('bundle gate requires every channel, recipient, and requirement', () => {
  const campaign = {
    requestedChannels: ['gmail', 'tara'],
    requirements: [{ id: 'goal' }, { id: 'channel:gmail' }, { id: 'channel:tara' }],
  };
  const bundle = {
    strategy: 'Use email to establish relevance and TARA for opted-in follow-up.',
    audience: { rationale: 'Use current qualified leads only.' }, content_pillars: ['Proof'],
    kpis: [{ name: 'Qualified replies', target: 'Track from baseline', source: 'Gmail' }],
    actions: [
      { id: 'email-1', channel: 'gmail', final_copy: 'Hello', payload: { to: 'lead@example.com', subject: 'A relevant idea' }, scheduled_offset_minutes: 0, rationale: 'Establish relevance' },
      { id: 'call-1', channel: 'tara', final_copy: 'Call contract', payload: { to: '+353123456789', opening: 'Hello, this is TARA calling about your request.', lawful_basis: 'consent', country: 'IE', timezone: 'Europe/Dublin' }, scheduled_offset_minutes: 60, rationale: 'Follow up with opted-in leads' },
    ],
    requirement_coverage: [
      { requirement_id: 'goal', action_ids: ['email-1'] },
      { requirement_id: 'channel:gmail', action_ids: ['email-1'] },
      { requirement_id: 'channel:tara', action_ids: ['call-1'] },
    ],
  };
  assert.deepEqual(validateCampaignBundle(bundle, campaign), []);
  const broken = structuredClone(bundle); delete broken.actions[1].payload.opening;
  assert.match(validateCampaignBundle(broken, campaign).join(' '), /speak-first opening/);
});

test('state and rollout gates reject unsafe transitions', () => {
  assert.equal(campaignsV2Enabled('org-a', { CAMPAIGNS_V2_ENABLED: 'true', CAMPAIGNS_V2_ORG_IDS: 'org-a' }), true);
  assert.equal(campaignWorkerEnabled({ CAMPAIGNS_V2_WORKER_ENABLED: 'false' }), false);
  assert.equal(campaignWorkerEnabled({ CAMPAIGNS_V2_WORKER_ENABLED: 'true' }), true);
  assert.deepEqual([...campaignExecutionChannels({ CAMPAIGNS_V2_EXECUTION_CHANNELS: 'x_organic,unknown' })], ['x_organic']);
  assert.equal(campaignChannelExecutionEnabled('x_organic', { CAMPAIGNS_V2_WORKER_ENABLED: 'true', CAMPAIGNS_V2_EXECUTION_CHANNELS: 'x_organic' }), true);
  assert.equal(campaignChannelExecutionEnabled('gmail', { CAMPAIGNS_V2_WORKER_ENABLED: 'true', CAMPAIGNS_V2_EXECUTION_CHANNELS: 'x_organic' }), false);
  assert.equal(assertTransition('READY_FOR_APPROVAL', 'RUNNING'), true);
  assert.throws(() => assertTransition('DRAFT', 'RUNNING'), { code: 'invalid_campaign_transition' });
});

test('campaign rooms use configured draft agents but exclude paused agents', () => {
  assert.deepEqual(campaignAgentWhere('org-a'), { orgId: 'org-a', archivedAt: null, status: { not: 'paused' } });
});

test('campaign room contract carries the campaign identity and completion tool', () => {
  const campaign = { id: 'campaign-a', ownerUserId: 'user-a', orgId: 'org-a', goal: 'Launch', objective: 'PRODUCT_LAUNCH', requestedChannels: ['x_organic'], brief: {}, audiencePolicy: {} };
  const kickoff = buildCampaignKickoff(campaign);
  const dispatch = buildCampaignRoomDispatch({
    campaign,
    room: { id: 'room-a', goal: 'Launch room' },
    turn: { id: 'turn-a', userMessage: kickoff },
    participantIds: ['agent-a'],
    briefSnapshot: { campaign_id: 'campaign-a' },
  });
  assert.match(kickoff, /campaign__submit_plan/);
  assert.equal(dispatch.task_tag, 'CAMPAIGN');
  assert.equal(dispatch.campaign_id, 'campaign-a');
  assert.equal(normalizeCampaignRoomEvent({ t: 'campaign_bundle', bundle: {} }).t, 'campaign_bundle');
  assert.equal(normalizeCampaignRoomEvent(null), null);
});

test('first Campaign Room event advances the durable run and records progress', async () => {
  const events = [];
  const run = { id: 'run-a', campaignId: 'campaign-a', roomId: 'room-a', turnId: 'turn-a', status: 'DISPATCHING', campaign: { orgId: 'org-a' } };
  const prisma = {
    campaignRun: {
      async findUnique() { return run; },
      async updateMany() { run.status = 'RUNNING'; return { count: 1 }; },
    },
    campaignEvent: { async create({ data }) { events.push(data); return data; } },
  };
  const result = await handleCampaignRoomEvent({ prisma, turnId: 'turn-a', event: { t: 'typing', agent: 'director' } });
  assert.equal(result.status, 'RUNNING');
  assert.equal(run.status, 'RUNNING');
  assert.equal(events[0].eventType, 'campaign_generation_started');
});

test('late dispatch transport errors cannot overwrite a completed campaign run', async () => {
  const prisma = {
    campaignRun: { async findFirst() { return { status: 'COMPLETED', campaign: { currentPlanVersionId: 'plan-a' } }; } },
  };
  const result = await handleCampaignDispatchError({ prisma, campaignId: 'campaign-a', error: new Error('socket closed') });
  assert.equal(result.ignored, true);
});

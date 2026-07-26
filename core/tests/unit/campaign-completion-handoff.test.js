import test from 'node:test';
import assert from 'node:assert/strict';

import { handleCampaignDispatchError, persistCampaignReadyHandoff } from '../../src/campaigns/pipeline.js';

function campaignRun() {
  return {
    id: 'run-a',
    campaignId: '11111111-1111-4111-8111-111111111111',
    roomId: '22222222-2222-4222-8222-222222222222',
    turnId: '33333333-3333-4333-8333-333333333333',
    status: 'COMPLETED',
    campaign: {
      orgId: '44444444-4444-4444-8444-444444444444',
      name: 'Product awareness',
      objective: 'AWARENESS',
      requestedChannels: ['x_organic'],
      goal: 'Internal orchestration text must not leak into the handoff.',
      brief: { prohibited_claims: 'Guaranteed results' },
    },
  };
}

test('accepted campaign contract emits one durable UI-safe campaign_ready handoff', async () => {
  const events = [];
  const prisma = {
    campaign: { async findUnique() { return { status: 'READY_FOR_APPROVAL', currentPlanVersionId: 'plan-a' }; } },
    campaignEvent: {
      async findFirst() { return events.find((event) => event.eventType === 'campaign_ready') || null; },
      async create({ data }) { const event = { id: 91n, ...data }; events.push(event); return event; },
    },
    campaignPlanVersion: { async findUnique() { throw new Error('version lookup should not be needed'); } },
  };
  const run = campaignRun();
  const result = { ok: true, campaignId: run.campaignId, planVersionId: 'plan-a', version: 3 };
  const bundle = { actions: [{ id: 'x-1' }, { id: 'x-2' }] };

  const first = await persistCampaignReadyHandoff({ prisma, run, result, bundle });
  const second = await persistCampaignReadyHandoff({ prisma, run, result, bundle });

  assert.equal(first.id, 91n);
  assert.equal(second.id, 91n);
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'campaign_ready');
  assert.deepEqual(events[0].data, {
    campaign_id: run.campaignId,
    room_id: run.roomId,
    turn_id: run.turnId,
    plan_version_id: 'plan-a',
    plan_version: 3,
    display: {
      title: 'Product awareness',
      objective: 'AWARENESS',
      channels: ['x_organic'],
      action_count: 2,
      status: 'READY_FOR_APPROVAL',
      message: 'Your campaign plan is ready to review.',
    },
  });
  assert.equal(JSON.stringify(events[0].data).includes('Internal orchestration'), false);
  assert.equal(JSON.stringify(events[0].data).includes('prohibited_claims'), false);
});

test('stale accepted callbacks cannot announce a superseded plan as ready', async () => {
  let writes = 0;
  const run = campaignRun();
  const prisma = {
    campaign: { async findUnique() { return { status: 'GENERATING', currentPlanVersionId: null }; } },
    campaignEvent: {
      async findFirst() { return null; },
      async create() { writes += 1; },
    },
  };

  const event = await persistCampaignReadyHandoff({
    prisma,
    run,
    result: { ok: true, planVersionId: 'superseded-plan', version: 1 },
    bundle: { actions: [] },
  });

  assert.equal(event, null);
  assert.equal(writes, 0);
});

test('late dispatch errors remain ignored after the ready handoff is durable', async () => {
  const prisma = {
    campaignRun: {
      async findFirst() {
        return {
          status: 'COMPLETED',
          campaign: { currentPlanVersionId: 'plan-a', status: 'READY_FOR_APPROVAL' },
        };
      },
    },
  };

  const result = await handleCampaignDispatchError({
    prisma,
    campaignId: '11111111-1111-4111-8111-111111111111',
    error: Object.assign(new Error('late 502'), { definitive: true }),
  });

  assert.deepEqual(result, {
    campaignId: '11111111-1111-4111-8111-111111111111',
    ignored: true,
  });
});

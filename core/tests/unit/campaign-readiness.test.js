import test from 'node:test';
import assert from 'node:assert/strict';

import { assessCampaignReadiness } from '../../src/campaigns/readiness.js';

function fixture(channel = 'x_organic') {
  const action = {
    id: 'action-1', channel, claim_status: 'verified', evidence_ids: ['evidence-1'],
    scheduled_offset_minutes: 0, creative_brief: { required: false },
  };
  return {
    campaign: { requestedChannels: [channel] },
    plan: { id: 'plan-1', bundle: {
      actions: [action],
      evidence: [{ id: 'evidence-1', status: 'verified' }],
      timeline: [{ action_id: 'action-1', scheduled_offset_minutes: 0 }],
      media_plan: { currency: null, channels: [{ channel, budget_amount: channel === 'x_organic' ? 0 : null }] },
      launch_plan: { ceilings: [], blocked_by: [] },
    } },
    actions: [{ id: 'persisted-1', planVersionId: 'plan-1', status: 'READY', payload: { source_action_id: 'action-1' } }],
    assets: [],
    capabilities: { channels: [{ id: channel, execution_ready: true }] },
    planIntegrity: true,
  };
}

test('readiness passes a verified organic plan with ready persisted actions', () => {
  const result = assessCampaignReadiness(fixture());
  assert.equal(result.decision, 'ready');
  assert.equal(result.blockers.length, 0);
  assert.ok(result.checks.every((item) => item.status === 'passed'));
});

test('readiness treats queued and succeeded actions as healthy after launch', () => {
  const input = fixture();
  input.campaign.status = 'RUNNING';
  input.actions[0].status = 'SUCCEEDED';
  input.actions.push({ id: 'persisted-2', planVersionId: 'plan-1', status: 'QUEUED', payload: { source_action_id: 'action-2' } });
  const result = assessCampaignReadiness(input);
  assert.equal(result.checks.find((item) => item.id === 'actions').status, 'passed');
  assert.deepEqual(result.checks.find((item) => item.id === 'actions').action_statuses, { SUCCEEDED: 1, QUEUED: 1 });
});

test('readiness identifies the exact failed action after launch', () => {
  const input = fixture();
  input.campaign.status = 'RUNNING';
  input.actions[0].status = 'FAILED';
  const result = assessCampaignReadiness(input);
  const actionCheck = result.checks.find((item) => item.id === 'actions');
  assert.equal(actionCheck.status, 'blocked');
  assert.match(actionCheck.detail, /persisted-1 \(FAILED\)/);
  assert.match(actionCheck.recovery, /provider error/);
});

test('readiness treats paused actions as healthy for a paused campaign', () => {
  const input = fixture();
  input.campaign.status = 'PAUSED';
  input.actions[0].status = 'PAUSED';
  const result = assessCampaignReadiness(input);
  assert.equal(result.checks.find((item) => item.id === 'actions').status, 'passed');
});

test('readiness blocks assumed public claims even when the channel is connected', () => {
  const input = fixture();
  input.plan.bundle.actions[0].claim_status = 'assumption';
  const result = assessCampaignReadiness(input);
  assert.equal(result.decision, 'blocked');
  assert.equal(result.blockers.find((item) => item.id === 'claims')?.action_ids[0], 'action-1');
  assert.equal(result.summary.next_action, 'Replace the claim, supply verified evidence, or mark the action as containing no factual claim.');
});

test('readiness blocks paid plans without account execution, budget, currency, and ceilings', () => {
  const input = fixture('meta');
  input.capabilities.channels[0].execution_ready = false;
  const result = assessCampaignReadiness(input);
  assert.equal(result.decision, 'blocked');
  assert.deepEqual(result.blockers.map((item) => item.id).filter((id) => ['channels', 'budget'].includes(id)), ['channels', 'budget']);
  assert.equal(result.blockers.find((item) => item.id === 'channels').detail, 'Execution is unavailable for meta.');
});

test('readiness presents X channels with distinct product labels', () => {
  const input = fixture('x_ads');
  input.capabilities.channels[0].execution_ready = false;
  const result = assessCampaignReadiness(input);
  assert.equal(result.blockers.find((item) => item.id === 'channels').detail, 'Execution is unavailable for Paid X Ads.');
});

test('readiness requires selected hash-bound assets only for visual actions', () => {
  const input = fixture();
  input.plan.bundle.actions[0].creative_brief = { required: true, aspect_ratio: '16:9' };
  let result = assessCampaignReadiness(input);
  assert.equal(result.blockers.some((item) => item.id === 'creative'), true);

  input.actions[0].payload.asset_id = 'asset-1';
  input.actions[0].payload.asset_hash = 'hash-1';
  input.actions[0].payload.asset_alt_text = 'Legal team using a shared AI workspace';
  input.assets.push({
    id: 'asset-1', actionId: 'persisted-1', kind: 'IMAGE', status: 'READY', contentHash: 'hash-1', deletedAt: null,
    contentType: 'image/png', sizeBytes: 1024, width: 1600, height: 900,
    metadata: { alt_text: 'Legal team using a shared AI workspace' },
  });
  result = assessCampaignReadiness(input);
  assert.equal(result.decision, 'ready');

  input.assets[0].width = 1536;
  input.assets[0].height = 1024;
  result = assessCampaignReadiness(input);
  assert.equal(result.decision, 'ready');

  input.assets[0].width = 900;
  input.assets[0].height = 1600;
  result = assessCampaignReadiness(input);
  assert.deepEqual(result.blockers.find((item) => item.id === 'creative').issues[0].problems, ['aspect_ratio_mismatch']);
});

test('plan-declared prose remains an advisory rather than mutation authority', () => {
  const input = fixture();
  input.plan.bundle.launch_plan.blocked_by = ['Confirm the final landing-page wording with the owner.'];
  const result = assessCampaignReadiness(input);
  assert.equal(result.decision, 'ready');
  assert.equal(result.advisories[0].id, 'plan_review');
});

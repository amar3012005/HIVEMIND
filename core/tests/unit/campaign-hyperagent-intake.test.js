import test from 'node:test';
import assert from 'node:assert/strict';

import { campaignActionRanges, campaignStatusAfterPlanning, normalizeCampaignInput } from '../../src/campaigns/service.js';
import { buildCampaignDisplayMessage, buildCampaignExecutionContext } from '../../src/campaigns/contracts.js';

test('HyperAgent campaign intake preserves exact action and visual counts', () => {
  const input = normalizeCampaignInput({
    goal: 'Reach German law firms with a three-post Instagram campaign',
    objective: 'LEAD_GENERATION',
    channels: ['instagram'],
    duration_days: 14,
    intensity: 'FOCUSED',
    action_count: 3,
    visuals_required: true,
    idempotency_key: 'room-turn-1',
  });

  assert.deepEqual(input.brief.cadence.expected_actions_by_channel.instagram, { minimum: 3, maximum: 3 });
  assert.equal(input.brief.action_count, 3);
  assert.deepEqual(input.brief.visual_delivery, {
    required: true,
    count: 3,
    coherence: 'shared_campaign_system',
  });
  assert.deepEqual(input.requirements.map((item) => item.id), [
    'goal', 'channel:instagram', 'delivery:action_count', 'delivery:visuals',
  ]);
});

test('explicit total action count is distributed deterministically across channels', () => {
  const cadence = campaignActionRanges({
    durationDays: 14,
    intensity: 'FOCUSED',
    channels: ['instagram', 'linkedin'],
    actionCount: 5,
  });
  assert.deepEqual(cadence.expected_actions_by_channel, {
    instagram: { minimum: 3, maximum: 3 },
    linkedin: { minimum: 2, maximum: 2 },
  });
  assert.equal(cadence.total_minimum, 5);
  assert.equal(cadence.total_maximum, 5);
});

test('canonical room dispatch makes exact visual delivery explicit', () => {
  const campaign = {
    id: 'campaign-1',
    goal: 'Reach German law firms',
    objective: 'LEAD_GENERATION',
    requestedChannels: ['instagram'],
    requirements: [],
    brief: {
      duration_days: 14,
      action_count: 3,
      cadence: { preset: 'focused', expected_actions_by_channel: { instagram: { minimum: 3, maximum: 3 } } },
      visual_delivery: { required: true, count: 3, coherence: 'shared_campaign_system' },
    },
  };
  assert.match(buildCampaignDisplayMessage(campaign), /exactly 3 campaign actions/i);
  assert.match(buildCampaignDisplayMessage(campaign), /generated visual for every campaign action/i);
  assert.match(buildCampaignExecutionContext(campaign), /VISUAL_DELIVERY_CONTRACT/);
  assert.match(buildCampaignExecutionContext(campaign), /expected visual count is 3/);
});

test('a visual campaign cannot become approval-ready before image production finishes', () => {
  assert.equal(campaignStatusAfterPlanning(3), 'PREPARING_ASSETS');
  assert.equal(campaignStatusAfterPlanning(0), 'READY_FOR_APPROVAL');
});

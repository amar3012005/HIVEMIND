import assert from 'node:assert/strict';
import test from 'node:test';
import { requestedCampaignChannels, resolveRuntimeCampaignChannels } from '../../src/runtime-playbooks/adapters/campaigns.js';

test('Runtime campaign planning preserves strategy-selected channels independently of connection state', () => {
  assert.deepEqual(requestedCampaignChannels({}, {
    recommended_channels: ['linkedin', 'instagram'],
  }), ['linkedin', 'instagram']);
});

test('Runtime campaign planning normalizes X aliases without overriding a multi-channel strategy', () => {
  assert.deepEqual(requestedCampaignChannels({
    channel_mix: ['Twitter', { id: 'linkedin' }, 'instagram', 'not-a-channel'],
  }, {}), ['x_organic', 'linkedin', 'instagram']);
});

test('first-life campaign execution defaults narrow its workload to X without affecting direct requests', () => {
  assert.deepEqual(resolveRuntimeCampaignChannels({
    target: { channels: ['instagram', 'linkedin', 'x'] },
    policy: { execution_defaults: { campaign: { channels: ['x_organic'] } } },
    plannable: ['instagram', 'linkedin', 'x_organic'],
  }), ['x_organic']);
  assert.deepEqual(resolveRuntimeCampaignChannels({
    target: { channels: ['instagram', 'linkedin'] },
    plannable: ['instagram', 'linkedin', 'x_organic'],
  }), ['instagram', 'linkedin']);
});

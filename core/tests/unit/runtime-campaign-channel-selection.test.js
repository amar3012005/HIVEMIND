import assert from 'node:assert/strict';
import test from 'node:test';
import { requestedCampaignChannels } from '../../src/runtime-playbooks/adapters/campaigns.js';

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

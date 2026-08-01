import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveHyperagentsOrganicChannels } from '../../src/campaigns/service.js';

test('HyperAgents campaign handoff retains only ready requested organic channels', () => {
  const channels = resolveHyperagentsOrganicChannels(['x_organic', 'instagram', 'facebook', 'tiktok'], {
    channels: [
      { id: 'x_organic', executable: true, execution_ready: true },
      { id: 'instagram', executable: false, execution_ready: false },
    ],
  });
  assert.deepEqual(channels, ['x_organic']);
});

test('HyperAgents campaign handoff falls back to the strongest connected organic channels', () => {
  const channels = resolveHyperagentsOrganicChannels(['instagram', 'facebook'], {
    channels: [
      { id: 'linkedin', executable: true, execution_ready: true },
      { id: 'x_organic', executable: true, execution_ready: true },
      { id: 'tara', executable: true, execution_ready: true },
    ],
  });
  assert.deepEqual(channels, ['x_organic', 'linkedin']);
});

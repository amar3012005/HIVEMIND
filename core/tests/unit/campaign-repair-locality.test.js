import test from 'node:test';
import assert from 'node:assert/strict';
import { __campaignRepairTest } from '../../src/campaigns/service.js';

test('campaign governance errors identify only implicated action ids', () => {
  const ids = __campaignRepairTest.affectedCampaignActionIds([
    'action post-2 is labeled no_claim but contains a customer, performance, or outcome claim',
    'X action post-4 payload.text must be 280 characters or fewer',
    'campaign timeline must span the requested horizon',
  ]);
  assert.deepEqual([...ids], ['post-2', 'post-4']);
});

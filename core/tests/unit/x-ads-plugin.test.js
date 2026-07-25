import { test } from 'node:test';
import assert from 'node:assert/strict';

import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { ConnectorRuntime } from '../../src/connectors/runtime/connector-runtime.js';
import { createXAdsPlugin } from '../../src/connectors/runtime/plugins/x_ads/index.js';

const context = {
  requestId: 'request-1', userId: '11111111-1111-4111-8111-111111111111',
  orgId: '22222222-2222-4222-8222-222222222222', surface: 'dashboard',
  approvalOwnedBySurface: true,
};

function fakePrisma() {
  return { xAdsCredential: { findUnique: async (args) => ({ id: 'official-x-ads', status: 'active', args }) } };
}

test('dashboard-confirmed publish enters connector runtime once', async () => {
  const calls = [];
  const registry = new ConnectorRegistry();
  registry.register(createXAdsPlugin({
    prisma: fakePrisma(),
    publishCampaign: async (args) => { calls.push(args); return { id: args.id, status: 'ACTIVE' }; },
  }));
  const runtime = new ConnectorRuntime({ registry, db: fakePrisma() });
  const result = await runtime.executeTool('x_ads__publish', {
    campaign_id: '33333333-3333-4333-8333-333333333333', confirmation_token: 'token',
  }, context);
  assert.equal(result.status, 'completed');
  assert.equal(result.content[0].data.status, 'ACTIVE');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].confirmationToken, 'token');
});

test('X Ads plugin fails closed when org has no OAuth1 connection', async () => {
  const registry = new ConnectorRegistry();
  registry.register(createXAdsPlugin({ prisma: { xAdsCredential: { findUnique: async () => null } } }));
  const runtime = new ConnectorRuntime({ registry, db: {} });
  const result = await runtime.executeTool('x_ads__pause', { campaign_id: '33333333-3333-4333-8333-333333333333' }, context);
  assert.equal(result.status, 'not_connected');
});

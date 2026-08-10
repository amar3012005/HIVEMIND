import test from 'node:test';
import assert from 'node:assert/strict';

import { processQueuedCampaignAssets } from '../../src/campaigns/image-service.js';

test('image capacity exhaustion keeps the campaign waiting instead of requesting user input', async () => {
  const asset = {
    id: 'asset-a', campaignId: 'campaign-a', actionId: 'action-a', status: 'QUEUED',
    provider: 'openrouter', prompt: 'A grounded campaign image', metadata: {},
    campaign: { id: 'campaign-a', orgId: 'org-a', status: 'READY_FOR_APPROVAL' },
    action: { id: 'action-a', payload: { creative_brief: { required: true } } },
  };
  const events = [];
  let campaignStatus = 'READY_FOR_APPROVAL';
  const prisma = {
    campaignAsset: {
      async updateMany({ where, data }) {
        if (where.id === asset.id && where.status === asset.status) {
          Object.assign(asset, data);
          return { count: 1 };
        }
        return { count: 0 };
      },
      async findFirst({ where }) {
        if (where.status === 'WAITING_QUOTA') return null;
        return asset.status === 'QUEUED' ? asset : null;
      },
      async count() { return 41; },
      async update({ data }) { Object.assign(asset, data); return asset; },
    },
    campaign: {
      async findUnique({ select }) {
        if (select) return { currentPlanVersionId: 'plan-a' };
        return {
          id: 'campaign-a', orgId: 'org-a', status: campaignStatus,
          currentPlanVersionId: 'plan-a', runs: [],
          actions: [{ id: 'action-a', payload: asset.action.payload, assets: [asset] }],
        };
      },
      async update({ data }) { campaignStatus = data.status; return { status: campaignStatus }; },
    },
    campaignEvent: { async create({ data }) { events.push(data); return data; } },
  };

  const result = await processQueuedCampaignAssets({ prisma, limit: 1, provider: async () => { throw new Error('provider must not run'); } });

  assert.equal(result.processed, 1);
  assert.equal(asset.status, 'WAITING_QUOTA');
  assert.equal(asset.metadata.error_code, 'campaign_image_daily_limit');
  assert.equal(campaignStatus, 'READY_FOR_APPROVAL');
  assert.equal(events.some((event) => event.eventType === 'campaign_asset_generation_deferred'), true);
  assert.equal(events.some((event) => event.eventType === 'campaign_asset_generation_failed'), false);
});

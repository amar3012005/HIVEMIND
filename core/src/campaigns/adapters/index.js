import { gmailAdapter } from './gmail.js';
import { taraAdapter } from './tara.js';
import { assertCampaignAdapter, CampaignAdapterError } from './contract.js';
import { xOrganicAdapter } from './x-organic.js';
import { createZernioSocialAdapter, zernioSocialAdapters } from './zernio-social.js';
import { zernioAdsAdapters } from './zernio-ads.js';
import { campaignChannelExecutionEnabled } from '../state.js';

const socialAdapters = zernioSocialAdapters.map((adapter) => (
  adapter.channel === 'x_organic' ? createZernioSocialAdapter('x_organic', { fallback: xOrganicAdapter }) : adapter
));
const ADAPTERS = new Map([...socialAdapters, ...zernioAdsAdapters, gmailAdapter, taraAdapter].map((adapter) => {
  assertCampaignAdapter(adapter); return [adapter.channel, adapter];
}));

export function getCampaignAdapter(channel) {
  const adapter = ADAPTERS.get(channel);
  if (adapter) return adapter;
  throw new CampaignAdapterError(`No campaign adapter exists for ${channel}`, { code: 'adapter_missing', outcome: 'BLOCKED' });
}

export async function executeCampaignAction(context) {
  if (!campaignChannelExecutionEnabled(context.action.channel)) {
    throw new CampaignAdapterError(`Execution is not enabled for ${context.action.channel}`, {
      code: 'campaign_channel_execution_disabled', outcome: 'BLOCKED',
    });
  }
  const adapter = getCampaignAdapter(context.action.channel);
  await adapter.checkCapability(context);
  adapter.validateAction(context);
  return adapter.execute(context);
}

export async function reconcileCampaignAction(context) {
  const adapter = getCampaignAdapter(context.action.channel);
  if (!adapter.reconcile) return { status: 'NEEDS_RECONCILIATION', reason: 'This adapter does not support reconciliation.' };
  return adapter.reconcile(context);
}

export async function syncCampaignActionMetrics(context) {
  return getCampaignAdapter(context.action.channel).syncMetrics(context);
}

export async function captureCampaignChannelBaseline(context) {
  const adapter = getCampaignAdapter(context.channel);
  return typeof adapter.captureBaseline === 'function' ? adapter.captureBaseline(context) : {};
}

export async function pauseCampaignAction(context) {
  return getCampaignAdapter(context.action.channel).pause(context);
}

export async function resumeCampaignAction(context) {
  const adapter = getCampaignAdapter(context.action.channel);
  return typeof adapter.resume === 'function' ? adapter.resume(context) : { status: 'QUEUED', provider_mutation: false };
}

import { gmailAdapter } from './gmail.js';
import { taraAdapter } from './tara.js';
import { CampaignAdapterError } from './contract.js';
import { xOrganicAdapter } from './x-organic.js';
import { campaignChannelExecutionEnabled } from '../state.js';

const ADAPTERS = new Map([xOrganicAdapter, gmailAdapter, taraAdapter].map((adapter) => [adapter.channel, adapter]));

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
  return getCampaignAdapter(context.action.channel).execute(context);
}

export async function reconcileCampaignAction(context) {
  const adapter = getCampaignAdapter(context.action.channel);
  if (!adapter.reconcile) return { status: 'NEEDS_RECONCILIATION', reason: 'This adapter does not support reconciliation.' };
  return adapter.reconcile(context);
}

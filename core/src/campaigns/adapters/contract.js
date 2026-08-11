export class CampaignAdapterError extends Error {
  constructor(message, { code = 'campaign_adapter_error', status = 409, outcome = 'FAILED', details = {} } = {}) {
    super(message);
    this.name = 'CampaignAdapterError';
    this.code = code;
    this.status = status;
    this.outcome = outcome;
    this.details = details;
  }
}

export function requireValue(value, message, code) {
  if (String(value || '').trim()) return String(value).trim();
  throw new CampaignAdapterError(message, { code, status: 400, outcome: 'BLOCKED' });
}

export function requireApproval(action, approval) {
  if (!approval || approval.status !== 'ACTIVE' || approval.campaignId !== action.campaignId
      || approval.planVersionId !== action.planVersionId) {
    throw new CampaignAdapterError('The active campaign approval no longer covers this action', {
      code: 'campaign_approval_invalid', outcome: 'BLOCKED',
    });
  }
  if (!Array.isArray(approval.channels) || !approval.channels.includes(action.channel)) {
    throw new CampaignAdapterError(`The approval does not cover ${action.channel}`, {
      code: 'campaign_channel_not_approved', outcome: 'BLOCKED',
    });
  }
  return approval;
}

export function publicProviderResponse(value = {}) {
  const source = value && typeof value === 'object' ? value : {};
  return Object.fromEntries(Object.entries(source).filter(([key]) => !/token|secret|authorization|credential/i.test(key)));
}

export function assertCampaignAdapter(adapter) {
  if (!adapter || typeof adapter !== 'object' || !String(adapter.channel || '').trim()) throw new Error('Campaign adapter needs a channel');
  for (const method of ['checkCapability', 'validateAction', 'execute', 'reconcile', 'pause', 'syncMetrics']) {
    if (typeof adapter[method] !== 'function') throw new Error(`Campaign adapter ${adapter.channel} needs ${method}()`);
  }
  return adapter;
}

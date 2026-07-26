export const CAMPAIGN_STATUSES = new Set([
  'DRAFT', 'GENERATING', 'NEEDS_INPUT', 'READY_FOR_APPROVAL', 'SCHEDULED',
  'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED',
]);

export const EXECUTABLE_V1_CHANNELS = new Set(['x_organic', 'gmail', 'tara']);
export const KNOWN_CHANNELS = new Set(['x_organic', 'gmail', 'tara', 'x_ads', 'linkedin', 'meta']);
export const OBJECTIVES = new Set([
  'AWARENESS', 'PRODUCT_LAUNCH', 'LEAD_GENERATION', 'WEBSITE_TRAFFIC',
  'THOUGHT_LEADERSHIP', 'EVENT_PROMOTION', 'RE_ENGAGEMENT', 'CUSTOM',
]);

export function campaignsV2Enabled(orgId, env = process.env) {
  if (!['1', 'true', 'yes', 'on'].includes(String(env.CAMPAIGNS_V2_ENABLED || '').toLowerCase())) return false;
  const allowlist = String(env.CAMPAIGNS_V2_ORG_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
  return allowlist.includes('*') || allowlist.includes(String(orgId));
}

export function requireCampaignsV2(orgId) {
  if (campaignsV2Enabled(orgId)) return;
  const error = new Error('AI Campaigns is not enabled for this organization');
  error.status = 403; error.code = 'campaigns_v2_disabled';
  throw error;
}

export function assertTransition(from, to) {
  const transitions = {
    DRAFT: ['GENERATING', 'CANCELLED'],
    GENERATING: ['NEEDS_INPUT', 'READY_FOR_APPROVAL', 'FAILED', 'CANCELLED'],
    NEEDS_INPUT: ['GENERATING', 'CANCELLED'],
    READY_FOR_APPROVAL: ['GENERATING', 'SCHEDULED', 'RUNNING', 'CANCELLED'],
    SCHEDULED: ['RUNNING', 'PAUSED', 'CANCELLED', 'FAILED'],
    RUNNING: ['PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED'],
    PAUSED: ['SCHEDULED', 'RUNNING', 'CANCELLED'],
    FAILED: ['GENERATING', 'CANCELLED'],
    COMPLETED: [], CANCELLED: [],
  };
  if ((transitions[from] || []).includes(to)) return true;
  const error = new Error(`Campaign cannot move from ${from} to ${to}`);
  error.status = 409; error.code = 'invalid_campaign_transition';
  throw error;
}

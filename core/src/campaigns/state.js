export const CAMPAIGN_STATUSES = new Set([
  'DRAFT', 'GENERATING', 'PREPARING_ASSETS', 'NEEDS_INPUT', 'READY_FOR_APPROVAL', 'SCHEDULED',
  'RUNNING', 'PAUSED', 'COMPLETED', 'FAILED', 'CANCELLED',
]);

export const EXECUTABLE_V1_CHANNELS = new Set([
  'x_organic', 'linkedin', 'instagram', 'facebook', 'tiktok', 'youtube',
  'pinterest', 'reddit', 'threads', 'bluesky', 'google_business', 'gmail', 'tara',
  'x_ads', 'google_ads', 'meta', 'linkedin_ads', 'tiktok_ads', 'pinterest_ads',
]);
export const PLANNABLE_CHANNELS = new Set([
  'x_organic', 'linkedin', 'instagram', 'facebook', 'tiktok', 'youtube',
  'pinterest', 'reddit', 'threads', 'bluesky', 'google_business', 'gmail', 'tara',
  'x_ads', 'google_ads', 'meta', 'linkedin_ads', 'youtube_ads', 'tiktok_ads',
  'microsoft_ads', 'apple_ads', 'amazon_ads', 'reddit_ads', 'pinterest_ads', 'snapchat_ads',
]);
export const KNOWN_CHANNELS = PLANNABLE_CHANNELS;
export const OBJECTIVES = new Set([
  'AWARENESS', 'PRODUCT_LAUNCH', 'LEAD_GENERATION', 'WEBSITE_TRAFFIC',
  'THOUGHT_LEADERSHIP', 'EVENT_PROMOTION', 'RE_ENGAGEMENT', 'CUSTOM',
]);

export function campaignsV2Enabled(orgId, env = process.env) {
  if (!['1', 'true', 'yes', 'on'].includes(String(env.CAMPAIGNS_V2_ENABLED || '').toLowerCase())) return false;
  const allowlist = String(env.CAMPAIGNS_V2_ORG_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
  return allowlist.includes('*') || allowlist.includes(String(orgId));
}

export function campaignWorkerEnabled(env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.CAMPAIGNS_V2_WORKER_ENABLED || '').toLowerCase());
}

export function campaignExecutionChannels(env = process.env) {
  return new Set(String(env.CAMPAIGNS_V2_EXECUTION_CHANNELS || '')
    .split(',').map((value) => value.trim().toLowerCase()).filter((value) => EXECUTABLE_V1_CHANNELS.has(value)));
}

export function campaignChannelExecutionEnabled(channel, env = process.env) {
  return campaignWorkerEnabled(env) && campaignExecutionChannels(env).has(String(channel || '').toLowerCase());
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
    GENERATING: ['PREPARING_ASSETS', 'NEEDS_INPUT', 'READY_FOR_APPROVAL', 'FAILED', 'CANCELLED'],
    PREPARING_ASSETS: ['READY_FOR_APPROVAL', 'NEEDS_INPUT', 'FAILED', 'CANCELLED'],
    NEEDS_INPUT: ['GENERATING', 'PREPARING_ASSETS', 'CANCELLED'],
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

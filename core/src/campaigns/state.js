export const CAMPAIGN_STATUSES = new Set([
  'DRAFT', 'GENERATING', 'PREPARING_ASSETS', 'NEEDS_INPUT', 'NEEDS_REPAIR', 'READY_FOR_APPROVAL', 'SCHEDULED',
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

// CAMPAIGN PLANNING FOLLOWS THE RUNTIME.
//
// `campaignsV2Enabled` conflated two very different questions behind one org allowlist:
// "may this org PLAN a campaign" and "may this org SEND to the outside world". Because
// CAMPAIGNS_V2_ORG_IDS listed exactly one org in production, every other tenant's HQ
// runtime died 2s into `prepare_campaign_contract` with
// `runtime_campaign_no_plannable_organic_channel` — the adapter asks for an organic
// channel that is either connected or `planning_ready`, and `planning_ready` was just
// this allowlist. Nothing about the strategy or the channels was actually wrong.
//
// The HQ runtime has NO org allowlist anywhere — `hqRuntime` is upserted per org on
// demand — so any org that can run the runtime must also be able to plan a campaign,
// or the runtime is shipped with a stage it can never clear.
//
// Planning creates a Campaign row, a Room and a contract draft. It causes no external
// side effect. Everything outward stays behind the STRICTER gates, untouched:
// `campaignWorkerEnabled`, `campaignExecutionChannels`, per-channel `connected`, and
// `campaignsV2Enabled` itself on the approve/launch/retry/control path. So this widens
// feature availability, never authority.
export function campaignPlanningEnabled(_orgId, env = process.env) {
  return ['1', 'true', 'yes', 'on'].includes(String(env.CAMPAIGNS_V2_ENABLED || '').toLowerCase());
}

export function requireCampaignPlanning(orgId) {
  if (campaignPlanningEnabled(orgId)) return;
  const error = new Error('AI Campaigns is not enabled on this deployment');
  error.status = 403; error.code = 'campaigns_v2_disabled';
  throw error;
}

// Outward execution keeps the explicit per-org allowlist. CAMPAIGNS_V2_ORG_IDS is now
// exactly that and nothing more: who may publish, not who may think.
export function requireCampaignsV2(orgId) {
  if (campaignsV2Enabled(orgId)) return;
  const error = new Error('AI Campaigns is not enabled for this organization');
  error.status = 403; error.code = 'campaigns_v2_disabled';
  throw error;
}

export function assertTransition(from, to) {
  const transitions = {
    DRAFT: ['GENERATING', 'CANCELLED'],
    GENERATING: ['PREPARING_ASSETS', 'NEEDS_INPUT', 'NEEDS_REPAIR', 'READY_FOR_APPROVAL', 'FAILED', 'CANCELLED'],
    PREPARING_ASSETS: ['READY_FOR_APPROVAL', 'NEEDS_INPUT', 'FAILED', 'CANCELLED'],
    NEEDS_INPUT: ['GENERATING', 'PREPARING_ASSETS', 'CANCELLED'],
    NEEDS_REPAIR: ['GENERATING', 'NEEDS_INPUT', 'READY_FOR_APPROVAL', 'CANCELLED'],
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

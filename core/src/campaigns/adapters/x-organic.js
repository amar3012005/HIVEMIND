import { createOrganicPost } from '../../x-ads/service.js';
import { directXRequest } from '../../x-ads/x-api-client.js';
import { X_AUTH_OAUTH2 } from '../../x-ads/x-auth-store.js';
import { CampaignAdapterError, requireApproval, requireValue } from './contract.js';

function validateXAction(action) {
  return requireValue(action?.payload?.text || action?.payload?.final_copy, 'X Post text is required', 'x_post_text_required');
}

export const xOrganicAdapter = {
  channel: 'x_organic',
  async checkCapability({ prisma, action }) {
    const credential = await prisma.xAdsCredential.findUnique({
      where: { orgId_userId_authKind: { orgId: action.campaign.orgId, userId: action.campaign.ownerUserId, authKind: X_AUTH_OAUTH2 } },
      select: { status: true },
    });
    if (credential?.status !== 'active') throw new CampaignAdapterError('The X connection is no longer active', { code: 'x_connection_inactive', outcome: 'BLOCKED' });
    return { connected: true };
  },
  validateAction({ action }) { validateXAction(action); return { valid: true }; },
  async execute({ prisma, action, approval, providers = {} }) {
    requireApproval(action, approval);
    const text = validateXAction(action);
    const post = await (providers.createOrganicPost || createOrganicPost)({
      prisma,
      userId: action.campaign.ownerUserId,
      orgId: action.campaign.orgId,
      text,
      confirmed: true,
    });
    return { externalId: post.id, response: post };
  },
  async reconcile({ action }) {
    if (action.externalId) return { status: 'SUCCEEDED', externalId: action.externalId };
    return { status: 'NEEDS_RECONCILIATION', reason: 'X returned no durable Post ID; inspect the connected account before retrying.' };
  },
  async pause() { return { status: 'PAUSED', scope: 'scheduler', provider_mutation: false }; },
  async captureBaseline({ prisma, campaign, providers = {} }) {
    const result = await (providers.directXRequest || directXRequest)({ prisma, userId: campaign.ownerUserId, orgId: campaign.orgId, path: '/2/users/me?user.fields=public_metrics' });
    const metrics = result?.data?.data?.public_metrics || {};
    return { followers: Number(metrics.followers_count || 0), posts: Number(metrics.tweet_count || 0), captured_at: new Date().toISOString() };
  },
  async syncMetrics({ prisma, action, providers = {} }) {
    if (!action.externalId) return { impressions: 0, likes: 0, replies: 0, reposts: 0, quotes: 0, bookmarks: 0, url_clicks: 0, engagements: 0, engagement_rate: 0 };
    const request = providers.directXRequest || directXRequest;
    const [postResult, userResult] = await Promise.all([
      request({ prisma, userId: action.campaign.ownerUserId, orgId: action.campaign.orgId, path: `/2/tweets/${encodeURIComponent(action.externalId)}?tweet.fields=created_at,public_metrics,organic_metrics,non_public_metrics` }),
      request({ prisma, userId: action.campaign.ownerUserId, orgId: action.campaign.orgId, path: '/2/users/me?user.fields=public_metrics' }),
    ]);
    const post = postResult?.data?.data || {}; const publicMetrics = post.public_metrics || {}; const organic = post.organic_metrics || post.non_public_metrics || {};
    const impressions = Number(organic.impression_count || publicMetrics.impression_count || 0);
    const likes = Number(publicMetrics.like_count || 0); const replies = Number(publicMetrics.reply_count || 0);
    const reposts = Number(publicMetrics.retweet_count || 0); const quotes = Number(publicMetrics.quote_count || 0);
    const bookmarks = Number(publicMetrics.bookmark_count || 0); const urlClicks = Number(organic.url_link_clicks || 0);
    const engagements = likes + replies + reposts + quotes + bookmarks + urlClicks;
    return {
      impressions, likes, replies, reposts, quotes, bookmarks, url_clicks: urlClicks, engagements,
      engagement_rate: impressions > 0 ? engagements / impressions : 0,
      followers: Number(userResult?.data?.data?.public_metrics?.followers_count || 0),
      post_url: `https://x.com/i/web/status/${action.externalId}`, captured_at: new Date().toISOString(),
    };
  },
};

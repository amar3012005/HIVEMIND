import { readSelectedCampaignAsset } from '../image-service.js';
import { requestZernio, resolveCampaignProviderAccount } from '../zernio-execution.js';
import { CampaignAdapterError, requireApproval, requireValue } from './contract.js';

const SOCIAL_CHANNEL_PLATFORM = Object.freeze({
  x_organic: 'twitter', linkedin: 'linkedin', instagram: 'instagram', facebook: 'facebook',
  tiktok: 'tiktok', youtube: 'youtube', pinterest: 'pinterest', reddit: 'reddit',
  threads: 'threads', bluesky: 'bluesky', google_business: 'googlebusiness',
});

function postId(payload) {
  return payload?.post?._id || payload?.post?.id || payload?.existingPost?._id || payload?.existingPost?.id || null;
}

function actionContent(action) {
  return requireValue(
    action?.payload?.text || action?.payload?.content || action?.payload?.final_copy || action?.finalCopy,
    'Social post content is required',
    'social_post_content_required',
  );
}

function finiteMetric(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : 0;
}

function normalizedMetrics(row) {
  const impressions = finiteMetric(row?.impressions);
  const engagements = finiteMetric(row?.engagements ?? row?.totalEngagements);
  const clicks = finiteMetric(row?.clicks ?? row?.urlClicks ?? row?.linkClicks);
  return {
    impressions,
    engagements,
    clicks,
    likes: finiteMetric(row?.likes),
    comments: finiteMetric(row?.comments ?? row?.replies),
    shares: finiteMetric(row?.shares ?? row?.reposts),
    follows: finiteMetric(row?.follows ?? row?.newFollowers),
    engagement_rate: impressions > 0 ? engagements / impressions : 0,
    click_through_rate: impressions > 0 ? clicks / impressions : 0,
  };
}

function selectTenantAccount(row, action, platform) {
  const requestedRef = action?.payload?.account_ref;
  if (requestedRef) return resolveCampaignProviderAccount({ row, accountRef: requestedRef, platform });
  const matches = (Array.isArray(row?.connectedAccounts) ? row.connectedAccounts : [])
    .filter((account) => account.platform === platform && account.status === 'CONNECTED' && account.can_publish);
  if (matches.length === 1) return matches[0].provider_account_id;
  if (!matches.length) {
    throw new CampaignAdapterError(`Connect ${platform} before launching this action`, {
      code: 'campaign_social_connection_required', outcome: 'BLOCKED', details: { platform },
    });
  }
  throw new CampaignAdapterError(`Choose which ${platform} account should publish this action`, {
    code: 'campaign_social_account_selection_required', outcome: 'BLOCKED',
    details: { platform, accounts: matches.map(({ account_ref, label, username }) => ({ account_ref, label, username })) },
  });
}

function connectedTenantAccounts(row, platform) {
  return (Array.isArray(row?.connectedAccounts) ? row.connectedAccounts : [])
    .filter((account) => account.platform === platform && account.status === 'CONNECTED' && account.can_publish);
}

async function useFallbackProvider({ prisma, row, action, platform, fallback }) {
  if (!fallback) return false;
  if (!connectedTenantAccounts(row, platform).length) return true;
  if (!action?.id || !action?.externalId || !prisma?.campaignActionAttempt?.findFirst) return false;
  const attempt = await prisma.campaignActionAttempt.findFirst({
    where: { actionId: action.id, status: 'SUCCEEDED' }, orderBy: { attempt: 'desc' }, select: { response: true },
  }).catch(() => null);
  if (attempt?.response?.provider === 'native_x') return true;
  if (attempt?.response?.provider === 'zernio') return false;
  return channelIsNativeX(action) && /^\d+$/.test(String(action.externalId));
}

function channelIsNativeX(action) {
  return action?.channel === 'x_organic';
}

export async function uploadSelectedAsset(prisma, action, providers) {
  const selected = await readSelectedCampaignAsset({ prisma, action });
  if (!selected) return { mediaItems: [], campaignAssetId: null, publicUrl: null };
  const contentType = selected.asset.contentType || 'image/png';
  const filename = selected.asset.filename || `campaign-${action.id}.png`;
  const presign = await (providers.requestZernio || requestZernio)('/media/presign', {
    method: 'POST', body: { filename, contentType, size: selected.bytes.length },
  });
  if (!presign?.uploadUrl || !presign?.publicUrl) {
    throw new CampaignAdapterError('Campaign media upload could not be prepared', { code: 'campaign_media_presign_failed', outcome: 'FAILED' });
  }
  const upload = await (providers.fetch || fetch)(presign.uploadUrl, {
    method: 'PUT', headers: { 'Content-Type': contentType }, body: selected.bytes,
    signal: AbortSignal.timeout(60_000),
  });
  if (!upload.ok) throw new CampaignAdapterError('Campaign media upload failed', { code: 'campaign_media_upload_failed', outcome: 'FAILED' });
  return { mediaItems: [{ url: presign.publicUrl, type: contentType.startsWith('video/') ? 'video' : 'image' }], campaignAssetId: selected.asset.id, publicUrl: presign.publicUrl };
}

export function createZernioSocialAdapter(channel, { fallback } = {}) {
  const platform = SOCIAL_CHANNEL_PLATFORM[channel];
  if (!platform) throw new Error(`Unknown Zernio social channel: ${channel}`);
  return {
    channel,
    async checkCapability(context) {
      const row = await context.prisma.zernioOrgProfile?.findUnique?.({ where: { orgId: context.action.campaign.orgId } }).catch(() => null);
      if ((!row || await useFallbackProvider({ prisma: context.prisma, row, action: context.action, platform, fallback })) && fallback) return fallback.checkCapability(context);
      if (!row) throw new CampaignAdapterError('Campaign publishing is not connected for this organization', { code: 'campaign_execution_profile_missing', outcome: 'BLOCKED' });
      selectTenantAccount(row, context.action, platform);
      return { connected: true, provider: 'campaign_execution' };
    },
    validateAction({ action }) {
      actionContent(action);
      return { valid: true };
    },
    async execute(context) {
      const { prisma, action, approval, providers = {} } = context;
      const row = await prisma.zernioOrgProfile?.findUnique?.({ where: { orgId: action.campaign.orgId } }).catch(() => null);
      if ((!row || await useFallbackProvider({ prisma, row, action, platform, fallback })) && fallback) return fallback.execute(context);
      requireApproval(action, approval);
      const accountId = selectTenantAccount(row, action, platform);
      const media = await uploadSelectedAsset(prisma, action, providers);
      const payload = await (providers.requestZernio || requestZernio)('/posts', {
        method: 'POST', requestId: action.id,
        body: {
          content: actionContent(action),
          platforms: [{ platform, accountId }],
          ...(media.mediaItems.length ? { mediaItems: media.mediaItems } : {}),
          publishNow: true,
        },
      });
      const externalId = postId(payload);
      if (!externalId) throw new CampaignAdapterError('Publishing returned no durable post identifier', { code: 'campaign_post_id_missing', outcome: 'NEEDS_RECONCILIATION' });
      return {
        externalId: String(externalId),
        response: { provider: 'zernio', status: payload?.post?.status || payload?.existingPost?.status || 'publishing', campaign_asset_id: media.campaignAssetId },
      };
    },
    async reconcile(context) {
      const row = await context.prisma.zernioOrgProfile?.findUnique?.({ where: { orgId: context.action.campaign.orgId } }).catch(() => null);
      if (await useFallbackProvider({ prisma: context.prisma, row, action: context.action, platform, fallback })) return fallback.reconcile(context);
      if (!context.action.externalId) {
        if (fallback) return fallback.reconcile(context);
        return { status: 'NEEDS_RECONCILIATION', reason: 'No durable post identifier is available.' };
      }
      const payload = await (context.providers?.requestZernio || requestZernio)(`/posts/${encodeURIComponent(context.action.externalId)}`);
      const status = String(payload?.post?.status || '').toLowerCase();
      if (status === 'published') return { status: 'SUCCEEDED', externalId: context.action.externalId, response: { status } };
      if (status === 'failed' || status === 'partial') return { status: 'FAILED', externalId: context.action.externalId, response: { status } };
      return { status: 'NEEDS_RECONCILIATION', externalId: context.action.externalId, response: { status: status || 'unknown' } };
    },
    async pause() { return { status: 'PAUSED', scope: 'scheduler', provider_mutation: false }; },
    async captureBaseline(context) {
      if (fallback?.captureBaseline && channel === 'x_organic') {
        const row = await context.prisma.zernioOrgProfile?.findUnique?.({ where: { orgId: context.campaign.orgId } }).catch(() => null);
        if (!row || !connectedTenantAccounts(row, platform).length) return fallback.captureBaseline(context);
      }
      return { captured_at: new Date().toISOString(), provider: 'campaign_execution' };
    },
    async syncMetrics(context) {
      const row = await context.prisma.zernioOrgProfile?.findUnique?.({ where: { orgId: context.action.campaign.orgId } }).catch(() => null);
      if (await useFallbackProvider({ prisma: context.prisma, row, action: context.action, platform, fallback })) return fallback.syncMetrics(context);
      if (!context.action.externalId) return {};
      const payload = await (context.providers?.requestZernio || requestZernio)(`/analytics?postId=${encodeURIComponent(context.action.externalId)}&limit=1`);
      const metricsRow = payload?.analytics?.[0] || payload?.data?.[0] || payload?.posts?.[0] || {};
      return { ...normalizedMetrics(metricsRow), captured_at: new Date().toISOString() };
    },
  };
}

export const zernioSocialAdapters = Object.keys(SOCIAL_CHANNEL_PLATFORM).map((channel) => createZernioSocialAdapter(channel));

export const __test = { connectedTenantAccounts, normalizedMetrics, selectTenantAccount, useFallbackProvider };

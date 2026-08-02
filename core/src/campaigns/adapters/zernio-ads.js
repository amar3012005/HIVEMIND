import {
  requestZernio, resolveCampaignAdAccount, resolveCampaignProviderAccount, ZERNIO_PAID_CHANNEL_PLATFORMS,
} from '../zernio-execution.js';
import { CampaignAdapterError, requireApproval, requireValue } from './contract.js';
import { uploadSelectedAsset } from './zernio-social.js';

const GOALS = new Set(['engagement', 'traffic', 'awareness', 'video_views', 'lead_generation', 'conversions', 'app_promotion']);
const OBJECTIVE_GOAL = Object.freeze({
  AWARENESS: 'awareness', PRODUCT_LAUNCH: 'awareness', LEAD_GENERATION: 'lead_generation',
  WEBSITE_TRAFFIC: 'traffic', THOUGHT_LEADERSHIP: 'engagement', EVENT_PROMOTION: 'awareness',
  RE_ENGAGEMENT: 'engagement', CUSTOM: 'engagement',
});

function adapterError(error) {
  if (error instanceof CampaignAdapterError) return error;
  return new CampaignAdapterError(error?.message || 'Advertising provider request failed', {
    code: error?.code || 'campaign_ads_provider_error', status: error?.status || 502,
    outcome: Number(error?.status) >= 500 || Number(error?.status) === 429 ? 'FAILED' : 'BLOCKED',
    details: error?.details || {},
  });
}

function findConnection(row, action, providerPlatform) {
  const requestedRef = action?.payload?.account_ref || row?.selectedAdAccounts?.[action?.channel]?.publisher_account_ref;
  if (requestedRef) return resolveCampaignProviderAccount({ row, accountRef: requestedRef, platform: providerPlatform });
  const matches = (Array.isArray(row?.connectedAccounts) ? row.connectedAccounts : [])
    .filter((account) => account.platform === providerPlatform && account.status === 'CONNECTED' && account.can_run_ads);
  if (matches.length === 1) return matches[0].provider_account_id;
  throw new CampaignAdapterError(matches.length ? 'Choose the connected advertising identity' : 'Connect the advertising platform before launch', {
    code: matches.length ? 'campaign_ads_connection_selection_required' : 'campaign_ads_connection_required', outcome: 'BLOCKED',
    details: { accounts: matches.map(({ account_ref, label, username }) => ({ account_ref, label, username })) },
  });
}

function finalCopy(action) {
  return requireValue(action?.payload?.text || action?.payload?.body || action?.payload?.final_copy, 'Advertising copy is required', 'campaign_ad_copy_required');
}

function destinationUrl(action) {
  const value = action?.payload?.link_url || action?.payload?.linkUrl || action?.payload?.destination_url || action?.campaign?.brief?.destination_url;
  if (!value) return null;
  try { return new URL(String(value)).toString(); } catch {
    throw new CampaignAdapterError('The advertising destination URL is invalid', { code: 'campaign_ad_destination_invalid', outcome: 'BLOCKED' });
  }
}

function targeting(action) {
  const source = action?.payload?.targeting && typeof action.payload.targeting === 'object' ? action.payload.targeting : action?.payload || {};
  const countries = Array.isArray(source.countries) ? source.countries.map((value) => String(value).trim().toUpperCase()) : [];
  if (countries.some((value) => !/^[A-Z]{2}$/.test(value))) {
    throw new CampaignAdapterError('Advertising countries must use ISO two-letter codes', { code: 'campaign_ad_countries_invalid', outcome: 'BLOCKED' });
  }
  const languages = Array.isArray(source.languages) ? source.languages.map((value) => String(value).trim()).filter(Boolean) : [];
  return { countries, languages };
}

async function approvedMediaPlan(prisma, action) {
  const plan = await prisma.campaignPlanVersion.findUnique({ where: { id: action.planVersionId }, select: { bundle: true } });
  const bundle = plan?.bundle && typeof plan.bundle === 'object' ? plan.bundle : {};
  const row = (Array.isArray(bundle?.media_plan?.channels) ? bundle.media_plan.channels : [])
    .find((item) => String(item?.channel || '').toLowerCase() === action.channel);
  const amount = Number(row?.budget_amount);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new CampaignAdapterError('A positive approved advertising budget is required', { code: 'campaign_ad_budget_required', outcome: 'BLOCKED' });
  }
  return { amount, currency: String(bundle?.media_plan?.currency || '').toUpperCase() || null };
}

function adId(payload) {
  return payload?.ad?._id || payload?.ad?.id || payload?.existingAd?._id || payload?.existingAd?.id || null;
}

function normalizedAdMetrics(payload) {
  const source = payload?.summary || payload?.ad?.metrics || payload?.metrics || {};
  const number = (value) => Number.isFinite(Number(value)) ? Number(value) : 0;
  return {
    spend: number(source.spend), impressions: number(source.impressions), reach: number(source.reach),
    clicks: number(source.clicks), conversions: number(source.conversions), engagements: number(source.engagement ?? source.engagements),
    ctr: number(source.ctr), cpc: number(source.cpc), cpm: number(source.cpm),
    currency: payload?.ad?.currency || payload?.currency || null,
  };
}

export function createZernioAdsAdapter(channel) {
  const providerPlatform = ZERNIO_PAID_CHANNEL_PLATFORMS[channel];
  if (!providerPlatform) throw new Error(`Unknown Zernio advertising channel: ${channel}`);
  return {
    channel,
    async checkCapability({ prisma, action }) {
      const row = await prisma.zernioOrgProfile.findUnique({ where: { orgId: action.campaign.orgId } }).catch(() => null);
      if (!row) throw new CampaignAdapterError('Campaign advertising is not connected for this organization', { code: 'campaign_execution_profile_missing', outcome: 'BLOCKED' });
      findConnection(row, action, providerPlatform);
      return { connected: true, provider: 'campaign_execution' };
    },
    validateAction({ action }) {
      const copy = finalCopy(action);
      if (channel === 'x_ads' && copy.length > 280) throw new CampaignAdapterError('X ad text must be 280 characters or fewer', { code: 'campaign_x_ad_text_too_long', outcome: 'BLOCKED' });
      targeting(action);
      return { valid: true };
    },
    async execute({ prisma, action, approval, providers = {} }) {
      requireApproval(action, approval);
      const row = await prisma.zernioOrgProfile.findUnique({ where: { orgId: action.campaign.orgId } }).catch(() => null);
      if (!row) throw new CampaignAdapterError('Campaign advertising is not connected for this organization', { code: 'campaign_execution_profile_missing', outcome: 'BLOCKED' });
      try {
        const providerAccountId = findConnection(row, action, providerPlatform);
        const selectedAccount = row?.selectedAdAccounts?.[action.channel] || {};
        const resolved = await resolveCampaignAdAccount({
          row, orgId: action.campaign.orgId,
          accountRef: action?.payload?.account_ref || selectedAccount.publisher_account_ref
            || (row.connectedAccounts || []).find((item) => item.provider_account_id === providerAccountId)?.account_ref,
          adAccountRef: action?.payload?.ad_account_ref || selectedAccount.ad_account_ref,
          fetchImpl: providers.fetch || globalThis.fetch,
        });
        const mediaPlan = await approvedMediaPlan(prisma, action);
        const media = await uploadSelectedAsset(prisma, action, providers);
        const selectedGoal = String(action?.payload?.goal || OBJECTIVE_GOAL[action.campaign.objective] || 'engagement').toLowerCase();
        if (!GOALS.has(selectedGoal)) throw new CampaignAdapterError('The selected advertising goal is unsupported', { code: 'campaign_ad_goal_invalid', outcome: 'BLOCKED' });
        const target = targeting(action);
        const linkUrl = destinationUrl(action);
        if (['traffic', 'conversions'].includes(selectedGoal) && !linkUrl) throw new CampaignAdapterError('This advertising goal requires a destination URL', { code: 'campaign_ad_destination_required', outcome: 'BLOCKED' });
        const payload = await (providers.requestZernio || requestZernio)('/ads/create', {
          method: 'POST', idempotencyKey: action.id,
          body: {
            accountId: providerAccountId,
            adAccountId: resolved.providerAdAccountId,
            name: String(action?.payload?.title || action?.campaign?.name || 'Singulance campaign').slice(0, 255),
            goal: selectedGoal,
            budgetAmount: mediaPlan.amount,
            budgetType: String(action?.payload?.budget_type || 'daily').toLowerCase() === 'lifetime' ? 'lifetime' : 'daily',
            body: finalCopy(action),
            ...(linkUrl ? { linkUrl } : {}),
            ...(media.publicUrl ? { imageUrl: media.publicUrl } : {}),
            ...(target.countries.length ? { countries: target.countries } : {}),
            ...(target.languages.length ? { languages: target.languages } : {}),
            ...(action?.payload?.dsa_beneficiary ? { dsaBeneficiary: String(action.payload.dsa_beneficiary).slice(0, 100) } : {}),
          },
        });
        const externalId = adId(payload);
        if (!externalId) throw new CampaignAdapterError('Advertising creation returned no durable identifier', { code: 'campaign_ad_id_missing', outcome: 'NEEDS_RECONCILIATION' });
        return { externalId: String(externalId), response: { status: payload?.ad?.status || 'in_review', currency: mediaPlan.currency, campaign_asset_id: media.campaignAssetId } };
      } catch (error) { throw adapterError(error); }
    },
    async reconcile({ action, providers = {} }) {
      if (!action.externalId) return { status: 'NEEDS_RECONCILIATION', reason: 'No durable advertising identifier is available.' };
      const payload = await (providers.requestZernio || requestZernio)(`/ads/${encodeURIComponent(action.externalId)}`);
      const status = String(payload?.ad?.status || '').toLowerCase();
      if (['active', 'paused', 'pending_review', 'in_review', 'completed'].includes(status)) return { status: 'SUCCEEDED', externalId: action.externalId, response: { status } };
      if (['rejected', 'error', 'cancelled'].includes(status)) return { status: 'FAILED', externalId: action.externalId, response: { status, rejection_reason: payload?.ad?.rejectionReason || null } };
      return { status: 'NEEDS_RECONCILIATION', externalId: action.externalId, response: { status: status || 'unknown' } };
    },
    async pause({ action, providers = {} }) {
      if (!action.externalId) return { status: 'PAUSED', scope: 'scheduler', provider_mutation: false };
      await (providers.requestZernio || requestZernio)(`/ads/${encodeURIComponent(action.externalId)}/status`, { method: 'PUT', body: { status: 'paused' } });
      return { status: 'PAUSED', provider_mutation: true };
    },
    async resume({ action, providers = {} }) {
      if (!action.externalId) return { status: 'QUEUED', scope: 'scheduler', provider_mutation: false };
      await (providers.requestZernio || requestZernio)(`/ads/${encodeURIComponent(action.externalId)}/status`, { method: 'PUT', body: { status: 'active' } });
      return { status: 'ACTIVE', provider_mutation: true };
    },
    async captureBaseline() { return { captured_at: new Date().toISOString(), provider: 'campaign_execution' }; },
    async syncMetrics({ action, providers = {} }) {
      if (!action.externalId) return {};
      const payload = await (providers.requestZernio || requestZernio)(`/ads/${encodeURIComponent(action.externalId)}/analytics`);
      return { ...normalizedAdMetrics(payload), captured_at: new Date().toISOString() };
    },
  };
}

export const zernioAdsAdapters = Object.keys(ZERNIO_PAID_CHANNEL_PLATFORMS).map((channel) => createZernioAdsAdapter(channel));
export const __test = { finalCopy, normalizedAdMetrics, targeting };

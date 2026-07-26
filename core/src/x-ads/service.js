import { getXCredential, X_AUTH_OAUTH1, X_AUTH_OAUTH2 } from './x-auth-store.js';
import { directAdsRequest, directXRequest, ProviderError } from './x-api-client.js';
import {
  amountToMicros, campaignConfirmationPayload, createConfirmation, inclusiveCampaignDays,
  inclusiveEndAt, normalizeTargets, serializeCampaign, validateDestinationUrl,
  validatePostText, verifyConfirmation,
} from './utils.js';

const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const TARGET_CACHE_MS = 7 * 24 * 60 * 60 * 1000;
const METRICS_CACHE_MS = 15 * 60 * 1000;
const targetCache = new Map();

export function xAdsBetaEnabled(orgId, env = process.env) {
  if (!['1', 'true', 'yes', 'on'].includes(String(env.X_ADS_ENABLED || '').toLowerCase())) return false;
  const allowed = String(env.X_ADS_BETA_ORG_IDS || '').split(',').map((v) => v.trim()).filter(Boolean);
  return allowed.includes('*') || allowed.includes(orgId);
}

async function connectionIds(prisma, userId, orgId) {
  const [x, ads] = await Promise.all([
    getXCredential({ prisma, userId, orgId, authKind: X_AUTH_OAUTH2 }),
    getXCredential({ prisma, userId, orgId, authKind: X_AUTH_OAUTH1 }),
  ]);
  return { prisma, userId, orgId, x, ads };
}

function requireBeta(orgId) {
  if (!xAdsBetaEnabled(orgId)) {
    const error = new Error('X Ads beta is not enabled for this organization');
    error.status = 403; error.code = 'x_ads_beta_disabled';
    throw error;
  }
}

function requireOrganicAccess(orgId) {
  if (xAdsBetaEnabled(orgId)) return;
  const campaignsEnabled = ['1', 'true', 'yes', 'on'].includes(String(process.env.CAMPAIGNS_V2_ENABLED || '').toLowerCase());
  const allowed = String(process.env.CAMPAIGNS_V2_ORG_IDS || '').split(',').map((value) => value.trim()).filter(Boolean);
  if (campaignsEnabled && (allowed.includes('*') || allowed.includes(String(orgId)))) return;
  const error = new Error('X Organic is not enabled for this organization');
  error.status = 403; error.code = 'x_organic_disabled'; throw error;
}

function requireAdsApproval() {
  if (process.env.X_ADS_API_APPROVED !== 'true') {
    const error = new Error('X Ads API access is not approved for customer publishing');
    error.status = 403; error.code = 'x_ads_api_not_approved';
    throw error;
  }
}

function requireConnections(ids, { x = false, ads = false } = {}) {
  if (x && !ids.x) { const e = new Error('Connect X before continuing'); e.status = 409; e.code = 'x_not_connected'; throw e; }
  if (ads && !ids.ads) { const e = new Error('Enable X Ads before continuing'); e.status = 409; e.code = 'x_ads_not_connected'; throw e; }
}

async function xRequest(ids, options) {
  return directXRequest({ prisma: ids.prisma, userId: ids.userId, orgId: ids.orgId, ...options });
}

async function adsRequest(ids, options) {
  return directAdsRequest({ prisma: ids.prisma, userId: ids.userId, orgId: ids.orgId, ...options });
}

function queryPath(path, params) {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params || {})) {
    if (value !== undefined && value !== null && value !== '') query.set(key, String(value));
  }
  const encoded = query.toString();
  return encoded ? `${path}?${encoded}` : path;
}

function providerData(result) { return result?.data?.data ?? result?.data ?? null; }

function promotedTweetError(promoted, fallback = 'X rejected the promoted Post.') {
  const reasons = promoted?.reasons_not_servable || promoted?.rejection_reasons || promoted?.approval_status_reason;
  if (!reasons) return fallback;
  const detail = Array.isArray(reasons) ? reasons.join(', ') : String(reasons);
  return `${fallback} ${detail}`.slice(0, 2000);
}

export function normalizeFundingInstrument(item, now = new Date()) {
  const expired = item.end_time && new Date(item.end_time).getTime() <= now.getTime();
  const eligible = item.able_to_fund !== false && !item.paused && !item.cancelled && !item.deleted && !expired;
  return {
    id: item.id, type: item.type, currency: item.currency,
    status: eligible ? 'ACTIVE' : (item.paused ? 'PAUSED' : 'UNAVAILABLE'),
    description: item.description || item.name || item.type || 'Funding instrument',
    eligible, reasons_not_able_to_fund: item.reasons_not_able_to_fund || [],
  };
}

export async function getStatus({ prisma, userId, orgId }) {
  const ids = await connectionIds(prisma, userId, orgId);
  let identity = null;
  let xConnected = Boolean(ids.x);
  if (ids.x) {
    try {
      identity = providerData(await xRequest(ids, { path: '/2/users/me?user.fields=id,name,username,profile_image_url' }));
    } catch (error) {
      if (error?.code === 'reauth_required') {
        xConnected = false;
        await prisma.xAdsCredential.updateMany({
          where: { orgId, userId, authKind: X_AUTH_OAUTH2 }, data: { status: 'expired' },
        }).catch(() => {});
      }
    }
  }
  return {
    beta_enabled: xAdsBetaEnabled(orgId),
    ads_api_approved: process.env.X_ADS_API_APPROVED === 'true',
    connections: { x: xConnected, x_ads: Boolean(ids.ads) },
    identity,
  };
}

export function validateOrganicPostText(value) {
  const text = String(value || '').trim();
  const length = Array.from(text).length;
  if (!text) { const e = new Error('Post text is required'); e.status = 400; e.code = 'post_text_required'; throw e; }
  if (length > 280) { const e = new Error('Post text must be 280 characters or fewer'); e.status = 400; e.code = 'post_text_too_long'; throw e; }
  return text;
}

export async function createOrganicPost({ prisma, userId, orgId, text, confirmed }) {
  requireOrganicAccess(orgId);
  if (confirmed !== true) { const e = new Error('Explicit confirmation is required before publishing'); e.status = 409; e.code = 'confirmation_required'; throw e; }
  const normalizedText = validateOrganicPostText(text);
  const ids = await connectionIds(prisma, userId, orgId);
  requireConnections(ids, { x: true });
  const response = await xRequest(ids, { method: 'POST', path: '/2/tweets', body: { text: normalizedText } });
  const post = providerData(response);
  if (!post?.id) throw new ProviderError('X did not return a Post ID');
  return { id: String(post.id), text: post.text || normalizedText, url: `https://x.com/i/web/status/${post.id}` };
}

export async function deleteOrganicPost({ prisma, userId, orgId, postId, confirmed }) {
  requireOrganicAccess(orgId);
  if (confirmed !== true) { const e = new Error('Explicit confirmation is required before deleting'); e.status = 409; e.code = 'confirmation_required'; throw e; }
  if (!/^[0-9]{1,19}$/.test(String(postId || ''))) { const e = new Error('A valid X Post ID is required'); e.status = 400; e.code = 'invalid_post_id'; throw e; }
  const ids = await connectionIds(prisma, userId, orgId);
  requireConnections(ids, { x: true });
  const response = await xRequest(ids, { method: 'DELETE', path: `/2/tweets/${postId}` });
  const result = providerData(response);
  if (result?.deleted !== true) throw new ProviderError('X did not confirm Post deletion');
  return { id: String(postId), deleted: true };
}

export async function listAccounts({ prisma, userId, orgId }) {
  requireBeta(orgId);
  requireAdsApproval();
  const ids = await connectionIds(prisma, userId, orgId);
  requireConnections(ids, { x: true, ads: true });
  const [meResponse, accountsResponse] = await Promise.all([
    xRequest(ids, { path: '/2/users/me?user.fields=id,name,username,profile_image_url' }),
    adsRequest(ids, { path: '/12/accounts?count=1000&with_deleted=false' }),
  ]);
  const identity = providerData(meResponse);
  const accounts = Array.isArray(providerData(accountsResponse)) ? providerData(accountsResponse) : [];
  const eligible = [];
  for (const account of accounts.filter((a) => !a.deleted && a.approval_status !== 'REJECTED')) {
    try {
      const [accessResponse, promotableResponse] = await Promise.all([
        adsRequest(ids, { path: `/12/accounts/${encodeURIComponent(account.id)}/authenticated_user_access` }),
        adsRequest(ids, { path: `/12/accounts/${encodeURIComponent(account.id)}/promotable_users?count=1000&with_deleted=false` }),
      ]);
      const access = providerData(accessResponse) || {};
      const permissions = Array.isArray(access.permissions) ? access.permissions : [];
      const promotable = Array.isArray(providerData(promotableResponse)) ? providerData(promotableResponse) : [];
      const matchingUser = promotable.find((item) => String(item.user_id) === String(identity?.id));
      const fullyPromotable = matchingUser?.promotable_user_type === 'FULL' ? matchingUser : null;
      eligible.push({
        id: account.id, name: account.name, business_name: account.business_name,
        timezone: account.timezone || 'UTC', approval_status: account.approval_status,
        permissions, writable: permissions.includes('ACCOUNT_ADMIN') || permissions.includes('AD_MANAGER'),
        identity_matches: String(access.user_id || '') === String(identity?.id || ''),
        promotable_user_id: fullyPromotable?.id || null,
        promotable_user_type: matchingUser?.promotable_user_type || null,
      });
    } catch (error) {
      eligible.push({ id: account.id, name: account.name, timezone: account.timezone || 'UTC', writable: false, error: error.message });
    }
  }
  return { identity, accounts: eligible };
}

export async function listFundingInstruments({ prisma, userId, orgId, accountId }) {
  requireBeta(orgId);
  requireAdsApproval();
  const ids = await connectionIds(prisma, userId, orgId);
  requireConnections(ids, { ads: true });
  const result = await adsRequest(ids, { path: `/12/accounts/${encodeURIComponent(accountId)}/funding_instruments?count=1000&with_deleted=false` });
  const data = Array.isArray(providerData(result)) ? providerData(result) : [];
  return {
    funding_instruments: data.filter((item) => !item.deleted).map((item) => normalizeFundingInstrument(item)),
  };
}

export async function searchTargets({ prisma, userId, orgId, type, query = '', countryCode = '', locationType = '' }) {
  requireBeta(orgId);
  requireAdsApproval();
  const ids = await connectionIds(prisma, userId, orgId);
  requireConnections(ids, { ads: true });
  const normalizedType = type === 'locations' ? 'locations' : 'languages';
  const params = normalizedType === 'locations'
    ? { q: query, country_code: countryCode, location_type: locationType || undefined, count: 200 }
    : { q: query, count: 200 };
  const cacheKey = `${normalizedType}:${JSON.stringify(params)}`;
  const cached = targetCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  const result = await adsRequest(ids, { path: queryPath(`/12/targeting_criteria/${normalizedType}`, params) });
  const value = { targets: Array.isArray(providerData(result)) ? providerData(result) : [] };
  targetCache.set(cacheKey, { value, expiresAt: Date.now() + TARGET_CACHE_MS });
  return value;
}

async function getScopedCampaign(prisma, id, orgId, userId, includeSteps = false) {
  const campaign = await prisma.xAdsCampaign.findFirst({ where: { id, orgId, userId }, ...(includeSteps ? { include: { steps: { orderBy: { updatedAt: 'asc' } } } } : {}) });
  if (!campaign) { const e = new Error('Campaign not found'); e.status = 404; e.code = 'not_found'; throw e; }
  return campaign;
}

async function validateAccountSelection({ prisma, userId, orgId, accountId, fundingInstrumentId }) {
  const { identity, accounts } = await listAccounts({ prisma, userId, orgId });
  const account = accounts.find((item) => item.id === accountId);
  if (!account) throw new Error('The selected advertiser account is unavailable');
  if (account.approval_status !== 'ACCEPTED') throw new Error('The selected advertiser account is not approved for delivery');
  if (!account.writable) throw new Error('The selected advertiser account requires ACCOUNT_ADMIN or AD_MANAGER access');
  if (!account.identity_matches || !account.promotable_user_id) throw new Error('The connected X identity cannot be promoted by this advertiser account');
  const { funding_instruments: instruments } = await listFundingInstruments({ prisma, userId, orgId, accountId });
  const funding = instruments.find((item) => item.id === fundingInstrumentId && item.eligible);
  if (!funding) throw new Error('Select an active funding instrument');
  return { identity, account, funding };
}

function validateDraftInput(input, { currency, timezone }) {
  const name = String(input.name || '').trim();
  if (!name || name.length > 255) throw new Error('name must contain 1 to 255 characters');
  const destinationUrl = validateDestinationUrl(input.destination_url);
  const postText = validatePostText(input.post_text, destinationUrl);
  const locations = normalizeTargets(input.location_targets, 'LOCATION');
  const languages = normalizeTargets(input.language_targets, 'LANGUAGE');
  const days = inclusiveCampaignDays(String(input.end_date || ''), timezone);
  const daily = amountToMicros(input.daily_budget, currency);
  return {
    name, destinationUrl, postText, locations, languages, days,
    daily, total: daily * BigInt(days), endDate: input.end_date,
    endAt: inclusiveEndAt(input.end_date, timezone),
  };
}

export async function createCampaign({ prisma, userId, orgId, input }) {
  requireBeta(orgId);
  const selected = await validateAccountSelection({ prisma, userId, orgId, accountId: input.ad_account_id, fundingInstrumentId: input.funding_instrument_id });
  const existingAccount = await prisma.xAdsCampaign.findFirst({
    where: { orgId, adAccountId: { not: null } }, select: { adAccountId: true, adAccountName: true },
  });
  if (existingAccount && existingAccount.adAccountId !== selected.account.id) {
    throw new Error(`X Ads V1 is already bound to advertiser account ${existingAccount.adAccountName || existingAccount.adAccountId}`);
  }
  const validated = validateDraftInput(input, { currency: selected.funding.currency, timezone: selected.account.timezone });
  const campaign = await prisma.xAdsCampaign.create({ data: {
    orgId, userId, adAccountId: selected.account.id, adAccountName: selected.account.name,
    fundingInstrumentId: selected.funding.id, xUserId: selected.identity.id, xUsername: selected.identity.username,
    name: validated.name, destinationUrl: validated.destinationUrl, postText: validated.postText,
    locationTargets: validated.locations, languageTargets: validated.languages,
    dailyBudgetMicros: validated.daily, totalBudgetMicros: validated.total,
    currency: selected.funding.currency, accountTimezone: selected.account.timezone,
    endDate: validated.endDate, endAt: validated.endAt,
  } });
  return serializeCampaign(campaign);
}

export async function updateCampaign({ prisma, userId, orgId, id, input }) {
  requireBeta(orgId);
  const current = await getScopedCampaign(prisma, id, orgId, userId);
  if (!['DRAFT', 'READY', 'SETUP_FAILED'].includes(current.status) || current.xCampaignId) throw new Error('Published campaign settings are immutable in V1');
  const accountId = input.ad_account_id || current.adAccountId;
  const fundingId = input.funding_instrument_id || current.fundingInstrumentId;
  const selected = await validateAccountSelection({ prisma, userId, orgId, accountId, fundingInstrumentId: fundingId });
  const existingAccount = await prisma.xAdsCampaign.findFirst({
    where: { orgId, id: { not: id }, adAccountId: { not: null } }, select: { adAccountId: true, adAccountName: true },
  });
  if (existingAccount && existingAccount.adAccountId !== selected.account.id) {
    throw new Error(`X Ads V1 is already bound to advertiser account ${existingAccount.adAccountName || existingAccount.adAccountId}`);
  }
  const merged = {
    name: input.name ?? current.name, destination_url: input.destination_url ?? current.destinationUrl,
    post_text: input.post_text ?? current.postText, location_targets: input.location_targets ?? current.locationTargets,
    language_targets: input.language_targets ?? current.languageTargets,
    daily_budget: input.daily_budget ?? microsToInput(current.dailyBudgetMicros, selected.funding.currency),
    end_date: input.end_date ?? current.endDate,
  };
  const validated = validateDraftInput(merged, { currency: selected.funding.currency, timezone: selected.account.timezone });
  const campaign = await prisma.xAdsCampaign.update({ where: { id }, data: {
    userId, adAccountId: selected.account.id, adAccountName: selected.account.name, fundingInstrumentId: selected.funding.id,
    xUserId: selected.identity.id, xUsername: selected.identity.username,
    name: validated.name, destinationUrl: validated.destinationUrl, postText: validated.postText,
    locationTargets: validated.locations, languageTargets: validated.languages,
    dailyBudgetMicros: validated.daily, totalBudgetMicros: validated.total,
    currency: selected.funding.currency, accountTimezone: selected.account.timezone,
    endDate: validated.endDate, endAt: validated.endAt, status: 'DRAFT',
    draftVersion: { increment: 1 }, confirmationHash: null, confirmationExpiresAt: null, lastError: null,
  } });
  return serializeCampaign(campaign);
}

function microsToInput(value, currency) {
  if (value == null) return '';
  const micros = BigInt(value); const whole = micros / 1_000_000n; const fraction = micros % 1_000_000n;
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits;
  return digits ? `${whole}.${fraction.toString().padStart(6, '0').slice(0, digits)}` : whole.toString();
}

export async function uploadCampaignImage({ prisma, userId, orgId, id, file }) {
  requireBeta(orgId);
  const current = await getScopedCampaign(prisma, id, orgId, userId);
  if (current.xPostId || !['DRAFT', 'READY', 'SETUP_FAILED'].includes(current.status)) throw new Error('Creative is immutable after Post creation');
  if (!file) throw new Error('image file is required');
  if (!IMAGE_TYPES.has(file.contentType)) throw new Error('image must be JPG, PNG, or WEBP');
  if (!file.data?.length || file.data.length > IMAGE_MAX_BYTES) throw new Error('image must be no larger than 5 MB');
  const campaign = await prisma.xAdsCampaign.update({ where: { id }, data: {
    imageData: file.data, imageContentType: file.contentType, imageFilename: String(file.filename || 'campaign-image').slice(0, 255),
    draftVersion: { increment: 1 }, status: 'DRAFT', confirmationHash: null, confirmationExpiresAt: null,
  } });
  return serializeCampaign(campaign);
}

export async function listCampaigns({ prisma, userId, orgId }) {
  requireBeta(orgId);
  const campaigns = await prisma.xAdsCampaign.findMany({ where: { orgId, userId }, orderBy: { createdAt: 'desc' }, take: 100 });
  return { campaigns: campaigns.map((campaign) => serializeCampaign(campaign)) };
}

export async function getCampaign({ prisma, userId, orgId, id }) {
  requireBeta(orgId);
  return serializeCampaign(await getScopedCampaign(prisma, id, orgId, userId, true), { includeSteps: true });
}

export async function prepareCampaign({ prisma, userId, orgId, id }) {
  requireBeta(orgId);
  let campaign = await getScopedCampaign(prisma, id, orgId, userId);
  if (campaign.xCampaignId && campaign.status !== 'SETUP_FAILED') throw new Error('Campaign has already entered publication');
  const selected = await validateAccountSelection({ prisma, userId, orgId, accountId: campaign.adAccountId, fundingInstrumentId: campaign.fundingInstrumentId });
  const validated = validateDraftInput({
    name: campaign.name, destination_url: campaign.destinationUrl, post_text: campaign.postText,
    location_targets: campaign.locationTargets, language_targets: campaign.languageTargets,
    daily_budget: microsToInput(campaign.dailyBudgetMicros, selected.funding.currency), end_date: campaign.endDate,
  }, { currency: selected.funding.currency, timezone: selected.account.timezone });
  campaign = await prisma.xAdsCampaign.update({ where: { id }, data: {
    xUserId: selected.identity.id, xUsername: selected.identity.username,
    dailyBudgetMicros: validated.daily, totalBudgetMicros: validated.total, endAt: validated.endAt,
    currency: selected.funding.currency, accountTimezone: selected.account.timezone,
  } });
  const confirmation = createConfirmation(campaign);
  campaign = await prisma.xAdsCampaign.update({ where: { id }, data: {
    status: campaign.xCampaignId ? 'SETUP_FAILED' : 'READY', confirmationHash: confirmation.hash, confirmationExpiresAt: confirmation.expiresAt,
  } });
  return {
    campaign: serializeCampaign(campaign), confirmation_token: confirmation.token,
    confirmation_expires_at: confirmation.expiresAt.toISOString(),
    summary: campaignConfirmationPayload(campaign),
  };
}

async function beginStep(prisma, campaignId, step) {
  const existing = await prisma.xAdsCampaignStep.findUnique({ where: { campaignId_step: { campaignId, step } } }).catch(() => null);
  if (existing?.status === 'COMPLETED') return { completed: true, row: existing };
  if (existing?.status === 'AMBIGUOUS') {
    const error = new Error(`${step} has an ambiguous provider result and requires reconciliation`);
    error.code = 'ambiguous_write'; throw error;
  }
  const row = await prisma.xAdsCampaignStep.upsert({
    where: { campaignId_step: { campaignId, step } },
    create: { campaignId, step, status: 'RUNNING', attempts: 1, startedAt: new Date() },
    update: { status: 'RUNNING', attempts: { increment: 1 }, error: null, startedAt: new Date() },
  });
  return { completed: false, row };
}

async function runStep(prisma, campaign, step, action, persist = () => ({})) {
  const started = await beginStep(prisma, campaign.id, step);
  if (started.completed) return campaign;
  try {
    const result = await action(campaign);
    const externalId = result?.externalId ? String(result.externalId) : null;
    const [updated] = await prisma.$transaction([
      prisma.xAdsCampaign.update({ where: { id: campaign.id }, data: persist(result) }),
      prisma.xAdsCampaignStep.update({ where: { campaignId_step: { campaignId: campaign.id, step } }, data: {
        status: 'COMPLETED', externalId, response: result?.snapshot || {}, error: null, completedAt: new Date(),
      } }),
    ]);
    return updated;
  } catch (error) {
    const ambiguous = error?.code === 'ambiguous_timeout';
    await prisma.xAdsCampaignStep.update({ where: { campaignId_step: { campaignId: campaign.id, step } }, data: {
      status: ambiguous ? 'AMBIGUOUS' : 'FAILED', error: String(error.message || error).slice(0, 2000),
    } }).catch(() => {});
    await prisma.xAdsCampaign.update({ where: { id: campaign.id }, data: { status: 'SETUP_FAILED', lastError: String(error.message || error).slice(0, 2000), publishLockAt: null } }).catch(() => {});
    throw error;
  }
}

export async function publishCampaign({ prisma, userId, orgId, id, confirmationToken }) {
  requireBeta(orgId);
  requireAdsApproval();
  let campaign = await getScopedCampaign(prisma, id, orgId, userId);
  if (['ACTIVE', 'PENDING_REVIEW', 'PAUSED', 'COMPLETED'].includes(campaign.status)) return serializeCampaign(await getScopedCampaign(prisma, id, orgId, userId, true), { includeSteps: true });
  if (!verifyConfirmation(campaign, confirmationToken)) { const e = new Error('Confirmation expired or campaign changed'); e.status = 409; e.code = 'confirmation_invalid'; throw e; }
  const lockBefore = new Date(Date.now() - 2 * 60 * 1000);
  const claimed = await prisma.xAdsCampaign.updateMany({
    where: { id, orgId, userId, OR: [{ publishLockAt: null }, { publishLockAt: { lt: lockBefore } }], status: { in: ['READY', 'SETUP_FAILED'] } },
    data: { status: 'PUBLISHING', publishLockAt: new Date(), lastError: null },
  });
  if (claimed.count !== 1) { const e = new Error('Campaign publication is already running'); e.status = 409; e.code = 'publish_in_progress'; throw e; }
  campaign = await getScopedCampaign(prisma, id, orgId, userId);
  let ids;
  try {
    ids = await connectionIds(prisma, userId, orgId);
    requireConnections(ids, { x: true, ads: true });
    await validateAccountSelection({ prisma, userId, orgId, accountId: campaign.adAccountId, fundingInstrumentId: campaign.fundingInstrumentId });
    inclusiveCampaignDays(campaign.endDate, campaign.accountTimezone);
  } catch (error) {
    await prisma.xAdsCampaign.update({ where: { id }, data: {
      status: 'SETUP_FAILED', lastError: String(error.message || error).slice(0, 2000), publishLockAt: null,
    } }).catch(() => {});
    throw error;
  }

  const campaignName = `${campaign.name} [HM:${campaign.id.slice(0, 8)}]`;
  campaign = await runStep(prisma, campaign, 'campaign', async () => {
    const response = await adsRequest(ids, { method: 'POST', path: queryPath(`/12/accounts/${campaign.adAccountId}/campaigns`, {
      funding_instrument_id: campaign.fundingInstrumentId, name: campaignName,
      daily_budget_amount_local_micro: campaign.dailyBudgetMicros.toString(), total_budget_amount_local_micro: campaign.totalBudgetMicros.toString(),
      entity_status: 'PAUSED', budget_optimization: 'CAMPAIGN', standard_delivery: 'true',
    }) });
    const data = providerData(response); return { externalId: data.id, snapshot: data };
  }, (result) => ({ xCampaignId: result.externalId, xSnapshot: { campaign: result.snapshot } }));

  campaign = await runStep(prisma, campaign, 'line_item', async () => {
    const response = await adsRequest(ids, { method: 'POST', path: queryPath(`/12/accounts/${campaign.adAccountId}/line_items`, {
      campaign_id: campaign.xCampaignId, name: `${campaign.name} - Website clicks`, objective: 'WEBSITE_CLICKS', goal: 'LINK_CLICKS',
      product_type: 'PROMOTED_TWEETS', placements: 'ALL_ON_TWITTER', bid_strategy: 'AUTO', entity_status: 'PAUSED',
      start_time: new Date().toISOString(), end_time: campaign.endAt.toISOString(),
    }) });
    const data = providerData(response); return { externalId: data.id, snapshot: data };
  }, (result) => ({ xLineItemId: result.externalId, xSnapshot: { ...(campaign.xSnapshot || {}), line_item: result.snapshot } }));

  campaign = await runStep(prisma, campaign, 'targeting', async () => {
    const targets = [...campaign.locationTargets, ...campaign.languageTargets].map((target) => ({
      operation_type: 'Create', params: { line_item_id: campaign.xLineItemId, targeting_type: target.targeting_type, targeting_value: target.targeting_value, operator_type: 'EQ' },
    }));
    const response = await adsRequest(ids, { method: 'POST', path: `/12/batch/accounts/${campaign.adAccountId}/targeting_criteria`, body: targets });
    return { snapshot: providerData(response) };
  }, (result) => ({ xSnapshot: { ...(campaign.xSnapshot || {}), targeting: result.snapshot } }));

  if (campaign.imageData && !campaign.xMediaId) {
    campaign = await runStep(prisma, campaign, 'media', async () => {
      const response = await xRequest(ids, { method: 'POST', path: '/2/media/upload', body: {
        media: Buffer.from(campaign.imageData).toString('base64'), media_category: 'tweet_image', media_type: campaign.imageContentType, shared: false,
      }, timeoutMs: 60_000 });
      const data = providerData(response); return { externalId: data.id || data.media_id_string, snapshot: data };
    }, (result) => ({ xMediaId: result.externalId, imageData: null }));
  }

  campaign = await runStep(prisma, campaign, 'post', async () => {
    const body = { text: campaign.postText };
    if (campaign.xMediaId) body.media = { media_ids: [campaign.xMediaId] };
    const response = await xRequest(ids, { method: 'POST', path: '/2/tweets', body });
    const data = providerData(response); return { externalId: data.id, snapshot: data };
  }, (result) => ({ xPostId: result.externalId, xSnapshot: { ...(campaign.xSnapshot || {}), post: result.snapshot } }));

  campaign = await runStep(prisma, campaign, 'promotion', async () => {
    const response = await adsRequest(ids, { method: 'POST', path: queryPath(`/12/accounts/${campaign.adAccountId}/promoted_tweets`, {
      line_item_id: campaign.xLineItemId, tweet_ids: campaign.xPostId,
    }) });
    const list = providerData(response); const data = Array.isArray(list) ? list[0] : list;
    return { externalId: data.id, snapshot: data };
  }, (result) => ({ xPromotedTweetId: result.externalId, xApprovalStatus: result.snapshot?.approval_status || null, xSnapshot: { ...(campaign.xSnapshot || {}), promoted_tweet: result.snapshot } }));

  campaign = await runStep(prisma, campaign, 'verify', async () => {
    const [campaignResponse, lineResponse, promotedResponse] = await Promise.all([
      adsRequest(ids, { path: `/12/accounts/${campaign.adAccountId}/campaigns/${campaign.xCampaignId}` }),
      adsRequest(ids, { path: `/12/accounts/${campaign.adAccountId}/line_items/${campaign.xLineItemId}` }),
      adsRequest(ids, { path: `/12/accounts/${campaign.adAccountId}/promoted_tweets/${campaign.xPromotedTweetId}` }),
    ]);
    const snapshot = { campaign: providerData(campaignResponse), line_item: providerData(lineResponse), promoted_tweet: providerData(promotedResponse) };
    return { snapshot };
  }, (result) => ({
    xApprovalStatus: result.snapshot.promoted_tweet?.approval_status || campaign.xApprovalStatus,
    xEffectiveStatus: result.snapshot.campaign?.effective_status || null,
    xSnapshot: result.snapshot,
  }));

  if (String(campaign.xApprovalStatus || '').toUpperCase() === 'REJECTED') {
    campaign = await prisma.xAdsCampaign.update({ where: { id }, data: {
      status: 'REJECTED', publishLockAt: null,
      lastError: promotedTweetError(campaign.xSnapshot?.promoted_tweet, 'X rejected the promoted Post.'),
    }, include: { steps: { orderBy: { updatedAt: 'asc' } } } });
    return serializeCampaign(campaign, { includeSteps: true });
  }

  campaign = await runStep(prisma, campaign, 'activate_line_item', async () => {
    const response = await adsRequest(ids, { method: 'PUT', path: queryPath(`/12/accounts/${campaign.adAccountId}/line_items/${campaign.xLineItemId}`, { entity_status: 'ACTIVE' }) });
    return { snapshot: providerData(response) };
  });
  campaign = await runStep(prisma, campaign, 'activate_campaign', async () => {
    const response = await adsRequest(ids, { method: 'PUT', path: queryPath(`/12/accounts/${campaign.adAccountId}/campaigns/${campaign.xCampaignId}`, { entity_status: 'ACTIVE' }) });
    return { snapshot: providerData(response) };
  });

  const approval = campaign.xApprovalStatus;
  campaign = await prisma.xAdsCampaign.update({ where: { id }, data: {
    status: approval && approval !== 'ACCEPTED' ? 'PENDING_REVIEW' : 'ACTIVE',
    publishLockAt: null, publishedAt: campaign.publishedAt || new Date(), lastError: null,
  }, include: { steps: { orderBy: { updatedAt: 'asc' } } } });
  return serializeCampaign(campaign, { includeSteps: true });
}

export async function changeCampaignState({ prisma, userId, orgId, id, action }) {
  requireBeta(orgId);
  if (action === 'resume') requireAdsApproval();
  let campaign = await getScopedCampaign(prisma, id, orgId, userId);
  if (!campaign.xCampaignId || !campaign.xLineItemId) throw new Error('Campaign has not been published');
  const ids = await connectionIds(prisma, userId, orgId); requireConnections(ids, { ads: true });
  if (action === 'resume') {
    inclusiveCampaignDays(campaign.endDate, campaign.accountTimezone);
    await validateAccountSelection({ prisma, userId, orgId, accountId: campaign.adAccountId, fundingInstrumentId: campaign.fundingInstrumentId });
  }
  const status = action === 'pause' ? 'PAUSED' : 'ACTIVE';
  const ordered = action === 'pause'
    ? [['campaigns', campaign.xCampaignId], ['line_items', campaign.xLineItemId]]
    : [['line_items', campaign.xLineItemId], ['campaigns', campaign.xCampaignId]];
  for (const [resource, externalId] of ordered) {
    await adsRequest(ids, { method: 'PUT', path: queryPath(`/12/accounts/${campaign.adAccountId}/${resource}/${externalId}`, { entity_status: status }) });
  }
  campaign = await prisma.xAdsCampaign.update({ where: { id }, data: { status, lastError: null } });
  return serializeCampaign(campaign);
}

function floorHour(date) { const d = new Date(date); d.setUTCMinutes(0, 0, 0); return d; }
function ceilHour(date) { const d = floorHour(date); if (d.getTime() < date.getTime()) d.setUTCHours(d.getUTCHours() + 1); return d; }
function sumMetric(value) { return Array.isArray(value) ? value.reduce((sum, item) => sum + (Number(item) || 0), 0) : (Number(value) || 0); }

export function calculateMetrics(rows) {
  const metricRows = rows.flatMap((row) => row?.id_data || []).map((row) => row?.metrics || {});
  const impressions = metricRows.reduce((sum, row) => sum + sumMetric(row.impressions), 0);
  const urlClicks = metricRows.reduce((sum, row) => sum + sumMetric(row.url_clicks), 0);
  const spendMicros = metricRows.reduce((sum, row) => sum + sumMetric(row.billed_charge_local_micro), 0);
  return {
    impressions, url_clicks: urlClicks, spend_micros: String(Math.round(spendMicros)),
    click_through_rate: impressions ? urlClicks / impressions : 0,
    cost_per_link_click_micros: urlClicks ? String(Math.round(spendMicros / urlClicks)) : null,
  };
}

export function reconciledCampaignStatus({ currentStatus, approval, effectiveStatus, endAt, now = new Date() }) {
  if (String(approval || '').toUpperCase() === 'REJECTED') return 'REJECTED';
  const ended = endAt && new Date(endAt).getTime() <= now.getTime();
  const completedAtX = /EXPIRED|COMPLETED|ENDED/.test(String(effectiveStatus || '').toUpperCase());
  return ended || completedAtX ? 'COMPLETED' : currentStatus;
}

export async function syncCampaign({ prisma, userId, orgId, id, force = false }) {
  requireBeta(orgId);
  let campaign = await getScopedCampaign(prisma, id, orgId, userId);
  if (!campaign.xCampaignId) return serializeCampaign(campaign);
  if (!force && campaign.metricsSyncedAt && Date.now() - campaign.metricsSyncedAt.getTime() < METRICS_CACHE_MS) return serializeCampaign(campaign);
  const ids = await connectionIds(prisma, userId, orgId); requireConnections(ids, { ads: true });
  const now = new Date();
  const startFloor = new Date(Math.max(floorHour(campaign.publishedAt || campaign.createdAt).getTime(), floorHour(new Date(now.getTime() - 90 * 86_400_000)).getTime()));
  let endCeil = ceilHour(now); if (endCeil <= startFloor) endCeil = new Date(startFloor.getTime() + 3_600_000);
  const [response, campaignResponse, promotedResponse] = await Promise.all([
    adsRequest(ids, { path: queryPath(`/12/stats/accounts/${campaign.adAccountId}`, {
    entity: 'CAMPAIGN', entity_ids: campaign.xCampaignId, start_time: startFloor.toISOString(), end_time: endCeil.toISOString(),
    granularity: 'TOTAL', placement: 'ALL_ON_TWITTER', metric_groups: 'ENGAGEMENT,BILLING',
    }) }),
    adsRequest(ids, { path: `/12/accounts/${campaign.adAccountId}/campaigns/${campaign.xCampaignId}` }),
    campaign.xPromotedTweetId
      ? adsRequest(ids, { path: `/12/accounts/${campaign.adAccountId}/promoted_tweets/${campaign.xPromotedTweetId}` })
      : Promise.resolve(null),
  ]);
  const rows = Array.isArray(providerData(response)) ? providerData(response) : [];
  const metrics = calculateMetrics(rows);
  const xCampaign = providerData(campaignResponse) || {};
  const promoted = promotedResponse ? (providerData(promotedResponse) || {}) : {};
  const approval = promoted.approval_status || campaign.xApprovalStatus;
  const effective = xCampaign.effective_status || campaign.xEffectiveStatus;
  const nextStatus = reconciledCampaignStatus({
    currentStatus: campaign.status, approval, effectiveStatus: effective, endAt: campaign.endAt, now,
  });
  campaign = await prisma.xAdsCampaign.update({ where: { id }, data: {
    metrics, metricsSyncedAt: new Date(), status: nextStatus,
    xApprovalStatus: approval || null, xEffectiveStatus: effective || null,
    xSnapshot: { ...(campaign.xSnapshot || {}), campaign: xCampaign, promoted_tweet: promoted },
    lastError: nextStatus === 'REJECTED' ? promotedTweetError(promoted) : campaign.lastError,
  } });
  return serializeCampaign(campaign);
}

export function normalizeServiceError(error) {
  if (error instanceof ProviderError) return { status: error.status, body: { error: error.code, message: error.message, provider_status: error.providerStatus, retry_at: error.rateReset } };
  return { status: error?.status || 400, body: { error: error?.code || 'x_ads_error', message: String(error?.message || error).slice(0, 500) } };
}

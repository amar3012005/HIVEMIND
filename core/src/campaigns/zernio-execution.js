import crypto from 'node:crypto';

const DEFAULT_BASE_URL = 'https://zernio.com/api/v1';
const DEFAULT_TIMEOUT_MS = 20_000;
const DEFAULT_SYNC_TTL_MS = 5 * 60_000;
const ZERNIO_WEBHOOK_EVENTS = Object.freeze([
  'account.connected', 'account.disconnected', 'account.ads.initial_sync_completed',
  'post.published', 'post.failed', 'post.partial', 'post.cancelled',
  'post.platform.published', 'post.platform.failed', 'comment.received', 'lead.received', 'ad.status_changed',
]);

export const ZERNIO_SOCIAL_PLATFORMS = Object.freeze([
  'facebook', 'instagram', 'linkedin', 'twitter', 'tiktok', 'youtube',
  'threads', 'reddit', 'pinterest', 'bluesky', 'googlebusiness', 'telegram',
  'snapchat', 'discord', 'whatsapp',
]);

const PLATFORM_CHANNELS = Object.freeze({
  twitter: ['x_organic'], x: ['x_organic'], xads: ['x_ads'],
  linkedin: ['linkedin'], instagram: ['instagram'], facebook: ['facebook', 'meta'],
  metaads: ['meta'], linkedinads: ['linkedin_ads'], googleads: ['google_ads'],
  tiktok: ['tiktok'], tiktokads: ['tiktok_ads'], pinterest: ['pinterest'], pinterestads: ['pinterest_ads'],
  youtube: ['youtube', 'youtube_ads'], threads: ['threads'], bluesky: ['bluesky'],
  reddit: ['reddit', 'reddit_ads'], snapchat: ['snapchat', 'snapchat_ads'],
});
const ZERNIO_AD_PLATFORMS = Object.freeze(['facebook', 'instagram', 'linkedin', 'tiktok', 'twitter', 'pinterest', 'googleads']);
const ZERNIO_AD_ACCOUNT_PLATFORMS = new Set(['metaads', 'linkedinads', 'googleads', 'tiktokads', 'pinterestads', 'xads']);
export const ZERNIO_PAID_CHANNEL_PLATFORMS = Object.freeze({
  x_ads: 'xads', meta: 'metaads', linkedin_ads: 'linkedinads', google_ads: 'googleads',
  tiktok_ads: 'tiktokads', pinterest_ads: 'pinterestads',
});

function configured() {
  return Boolean(process.env.ZERNIO_API_KEY);
}

function providerError(message, status = 502, code = 'zernio_provider_error', details = undefined) {
  return Object.assign(new Error(message), { status, code, details });
}

export async function requestZernio(path, { method = 'GET', body, idempotencyKey, requestId, fetchImpl = globalThis.fetch } = {}) {
  if (!configured()) throw providerError('Campaign execution provider is not configured', 503, 'campaign_execution_not_configured');
  if (typeof fetchImpl !== 'function') throw providerError('Campaign execution HTTP client is unavailable', 503, 'campaign_execution_unavailable');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.ZERNIO_TIMEOUT_MS || DEFAULT_TIMEOUT_MS));
  try {
    const response = await fetchImpl(`${String(process.env.ZERNIO_API_BASE_URL || DEFAULT_BASE_URL).replace(/\/$/, '')}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${process.env.ZERNIO_API_KEY}`,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
        ...(requestId ? { 'x-request-id': requestId } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = {};
    try { payload = text ? JSON.parse(text) : {}; } catch { payload = { message: text.slice(0, 500) }; }
    if (!response.ok) {
      throw providerError(
        payload?.error || payload?.message || `Campaign execution provider returned ${response.status}`,
        response.status === 429 ? 429 : (response.status >= 500 ? 502 : response.status),
        payload?.code || 'zernio_provider_error',
        { reason: payload?.reason || null, retry_after: response.headers?.get?.('retry-after') || null },
      );
    }
    return payload;
  } catch (error) {
    if (error?.name === 'AbortError') throw providerError('Campaign execution provider timed out', 504, 'campaign_execution_timeout');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function profileName(org) {
  const base = String(org?.name || org?.slug || 'Organization').trim().slice(0, 180);
  return `${base} · Singulance ${String(org?.id || '').slice(0, 8)}`;
}

function profileIdFrom(payload) {
  return payload?.profile?._id || payload?.profile?.id || payload?.data?.profile?._id || payload?.details?.existingProfileId || null;
}

function accountProfileId(account) {
  if (typeof account?.profileId === 'string') return account.profileId;
  return account?.profileId?._id || account?.profile?._id || account?.profile?.id || null;
}

function accountReference(orgId, providerAccountId) {
  const secret = process.env.ZERNIO_ACCOUNT_REF_SECRET || process.env.ZERNIO_API_KEY || 'campaign-execution-reference';
  return crypto.createHmac('sha256', secret).update(`${orgId}:${providerAccountId}`).digest('base64url');
}

function adAccountReference(orgId, providerAccountId, adAccountId) {
  return accountReference(orgId, `ad:${providerAccountId}:${adAccountId}`);
}

function connectStateSecret() {
  return process.env.ZERNIO_CONNECT_STATE_SECRET || process.env.ZERNIO_ACCOUNT_REF_SECRET || process.env.ZERNIO_API_KEY || '';
}

function signConnectState(payload) {
  const secret = connectStateSecret();
  if (!secret) throw providerError('Campaign connection state signing is not configured', 503, 'campaign_connection_state_unavailable');
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(encoded).digest('base64url');
  return `${encoded}.${signature}`;
}

function verifyConnectState(value) {
  const secret = connectStateSecret();
  const [encoded, received] = String(value || '').split('.');
  if (!secret || !encoded || !received) throw providerError('Campaign connection state is invalid', 400, 'campaign_connection_state_invalid');
  const expected = crypto.createHmac('sha256', secret).update(encoded).digest();
  let actual;
  try { actual = Buffer.from(received, 'base64url'); } catch { actual = Buffer.alloc(0); }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    throw providerError('Campaign connection state is invalid', 400, 'campaign_connection_state_invalid');
  }
  let payload;
  try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')); } catch {
    throw providerError('Campaign connection state is invalid', 400, 'campaign_connection_state_invalid');
  }
  if (!payload?.path || !payload?.platform || Number(payload.expires_at) < Date.now()) {
    throw providerError('Campaign connection state has expired', 400, 'campaign_connection_state_expired');
  }
  return payload;
}

function normalizeAccount(account, orgId = '') {
  const platform = String(account?.platform || account?.provider || '').trim().toLowerCase();
  const status = account?.isActive === false || account?.status === 'disconnected' ? 'DISCONNECTED' : 'CONNECTED';
  const isAdsAccount = ZERNIO_AD_ACCOUNT_PLATFORMS.has(platform);
  const canPublish = !isAdsAccount && status === 'CONNECTED' && account?.canPost !== false;
  const canRunAds = isAdsAccount && status === 'CONNECTED';
  return {
    provider_account_id: String(account?._id || account?.id || account?.accountId || ''),
    account_ref: accountReference(orgId, String(account?._id || account?.id || account?.accountId || '')),
    platform,
    label: String(account?.displayName || account?.username || account?.name || platform || 'Connected account').slice(0, 255),
    username: account?.username ? String(account.username).slice(0, 160) : null,
    status,
    can_publish: canPublish,
    can_schedule: canPublish,
    can_run_ads: canRunAds,
    analytics_ready: status === 'CONNECTED' && Boolean(account?.hasAnalyticsAccess || account?.analyticsSupported),
  };
}

function capabilitySnapshot(accounts) {
  const channels = new Map();
  for (const account of accounts) {
    for (const channel of PLATFORM_CHANNELS[account.platform] || [account.platform]) {
      if (!channel) continue;
      const paid = channel.endsWith('_ads') || channel === 'meta';
      const ready = paid ? account.can_run_ads : account.can_publish;
      const current = channels.get(channel);
      channels.set(channel, {
        id: channel,
        connected: current?.connected || account.status === 'CONNECTED',
        executable: current?.executable || ready,
        execution_ready: current?.execution_ready || ready,
        planning_ready: true,
        reason: ready ? null : (account.status === 'CONNECTED' ? 'provider_capability_unavailable' : 'reconnect_account'),
        execution_reason: ready ? null : (account.status === 'CONNECTED' ? 'provider_capability_unavailable' : 'reconnect_account'),
      });
    }
  }
  return {
    can_publish: accounts.some((account) => account.can_publish),
    can_schedule: accounts.some((account) => account.can_schedule),
    can_run_ads: accounts.some((account) => account.can_run_ads),
    can_read_analytics: accounts.some((account) => account.analytics_ready),
    channels: [...channels.values()],
  };
}

function publicState(row) {
  if (!row) return {
    configured: configured(), status: 'UNPROVISIONED', account_count: 0,
    connected_accounts: [], channels: [], can_publish: false, can_schedule: false,
    can_run_ads: false, can_read_analytics: false, selected_ad_accounts: {}, last_synced_at: null,
  };
  const accounts = Array.isArray(row.connectedAccounts) ? row.connectedAccounts : [];
  const caps = row.capabilities && typeof row.capabilities === 'object' ? row.capabilities : capabilitySnapshot(accounts);
  return {
    configured: configured(), status: row.status, account_count: accounts.filter((account) => account.status === 'CONNECTED').length,
    connected_accounts: accounts.map(({ provider_account_id, ...safe }) => safe),
    channels: Array.isArray(caps.channels) ? caps.channels : [],
    can_publish: Boolean(caps.can_publish), can_schedule: Boolean(caps.can_schedule),
    can_run_ads: Boolean(caps.can_run_ads), can_read_analytics: Boolean(caps.can_read_analytics),
    selected_ad_accounts: row.selectedAdAccounts && typeof row.selectedAdAccounts === 'object' ? row.selectedAdAccounts : {},
    last_synced_at: row.lastSyncedAt || null, error: row.lastError || null,
  };
}

export async function getCampaignConnectionState({ prisma, orgId }) {
  let row = null;
  try {
    if (prisma.zernioOrgProfile?.findUnique) row = await prisma.zernioOrgProfile.findUnique({ where: { orgId } });
  } catch { /* An unapplied additive migration degrades to unprovisioned. */ }
  return publicState(row || null);
}

export async function syncCampaignConnectionState({ prisma, orgId, fetchImpl = globalThis.fetch }) {
  const row = await prisma.zernioOrgProfile.findUnique({ where: { orgId } });
  if (!row) return getCampaignConnectionState({ prisma, orgId });
  try {
    const query = new URLSearchParams({ profileId: row.zernioProfileId, includeOverLimit: 'true' });
    const [payload, healthPayload] = await Promise.all([
      requestZernio(`/accounts?${query}`, { fetchImpl }),
      requestZernio(`/accounts/health?profileId=${encodeURIComponent(row.zernioProfileId)}`, { fetchImpl }).catch(() => null),
    ]);
    const source = Array.isArray(payload?.accounts) ? payload.accounts : [];
    const healthAccounts = Array.isArray(healthPayload?.accounts) ? healthPayload.accounts : (Array.isArray(healthPayload?.data?.accounts) ? healthPayload.data.accounts : []);
    const healthByAccountId = new Map(healthAccounts.map((account) => [String(account?.accountId || account?._id || account?.id || ''), account]));
    const accounts = source
      .filter((account) => accountProfileId(account) === row.zernioProfileId)
      .map((account) => {
        const id = String(account?._id || account?.id || account?.accountId || '');
        const health = healthByAccountId.get(id);
        return normalizeAccount({ ...account, hasAnalyticsAccess: health?.canFetchAnalytics ?? account?.hasAnalyticsAccess }, orgId);
      });
    const baseCapabilities = capabilitySnapshot(accounts);
    const { capabilities, selectedAdAccounts } = await discoverAdAccountCapabilities({
      accounts, capabilities: baseCapabilities, selectedAdAccounts: row.selectedAdAccounts, orgId, fetchImpl,
    });
    const updated = await prisma.zernioOrgProfile.update({
      where: { orgId }, data: { status: 'ACTIVE', connectedAccounts: accounts, capabilities, selectedAdAccounts, lastSyncedAt: new Date(), lastError: null },
    });
    return publicState(updated);
  } catch (error) {
    await prisma.zernioOrgProfile.update({ where: { orgId }, data: { status: 'DEGRADED', lastError: error.message.slice(0, 1000) } }).catch(() => {});
    throw error;
  }
}

export async function provisionCampaignConnectionState({ prisma, orgId, userId, fetchImpl = globalThis.fetch }) {
  const existing = await prisma.zernioOrgProfile.findUnique({ where: { orgId } });
  if (existing) {
    const syncedAt = existing.lastSyncedAt ? new Date(existing.lastSyncedAt).getTime() : 0;
    const syncTtlMs = Number(process.env.ZERNIO_ACCOUNT_SYNC_TTL_MS || DEFAULT_SYNC_TTL_MS);
    if (syncedAt && Date.now() - syncedAt < syncTtlMs) return publicState(existing);
    return syncCampaignConnectionState({ prisma, orgId, fetchImpl });
  }
  const org = await prisma.organization.findUnique({ where: { id: orgId }, select: { id: true, name: true, slug: true } });
  if (!org) throw providerError('Organization not found', 404, 'organization_not_found');
  const displayName = profileName(org);
  let payload;
  try {
    payload = await requestZernio('/profiles', {
      method: 'POST', body: { name: displayName, description: 'Singulance organization campaign execution' },
      idempotencyKey: `singulance-org-${orgId}`, fetchImpl,
    });
  } catch (error) {
    if (error?.status !== 409) throw error;
    const lookup = await requestZernio(`/profiles?${new URLSearchParams({ name: displayName })}`, { fetchImpl });
    payload = { profile: (lookup?.profiles || [])[0] };
  }
  const zernioProfileId = profileIdFrom(payload);
  if (!zernioProfileId) throw providerError('Campaign execution profile could not be reconciled', 502, 'campaign_profile_reconcile_failed');
  await prisma.zernioOrgProfile.upsert({
    where: { orgId },
    create: { orgId, zernioProfileId, displayName, createdBy: userId, status: 'ACTIVE' },
    update: { zernioProfileId, displayName, status: 'ACTIVE', lastError: null },
  });
  await ensureCampaignWebhook({ fetchImpl }).catch(async (error) => {
    await prisma.zernioOrgProfile.update({ where: { orgId }, data: { lastError: `Webhook setup: ${String(error?.message || error).slice(0, 900)}` } }).catch(() => {});
  });
  return syncCampaignConnectionState({ prisma, orgId, fetchImpl });
}

export async function ensureCampaignWebhook({ fetchImpl = globalThis.fetch } = {}) {
  const secret = String(process.env.ZERNIO_WEBHOOK_SECRET || '').trim();
  const publicBase = String(process.env.ZERNIO_WEBHOOK_PUBLIC_URL || process.env.HIVEMIND_PUBLIC_URL || '').replace(/\/$/, '');
  if (!secret || !publicBase) return { configured: false, reason: 'webhook_environment_missing' };
  const url = publicBase.endsWith('/api/campaigns/webhooks/zernio') ? publicBase : `${publicBase}/api/campaigns/webhooks/zernio`;
  const name = 'Singulance Campaign Intelligence';
  const payload = await requestZernio('/webhooks/settings', { fetchImpl });
  const existing = (Array.isArray(payload?.webhooks) ? payload.webhooks : []).find((item) => item?.name === name || item?.url === url);
  const body = { name, url, secret, events: [...ZERNIO_WEBHOOK_EVENTS], isActive: true };
  if (existing?._id) {
    await requestZernio('/webhooks/settings', { method: 'PUT', body: { _id: existing._id, ...body }, fetchImpl });
    return { configured: true, created: false };
  }
  await requestZernio('/webhooks/settings', { method: 'POST', body, fetchImpl });
  return { configured: true, created: true };
}

function normalizePlatform(platform, { ads = false } = {}) {
  const value = String(platform || '').trim().toLowerCase();
  const supported = ads ? ZERNIO_AD_PLATFORMS : ZERNIO_SOCIAL_PLATFORMS;
  if (!supported.includes(value)) {
    throw providerError(
      ads ? 'Paid campaigns are not supported for this platform' : 'This social platform is not supported',
      400,
      ads ? 'campaign_ads_platform_unsupported' : 'campaign_platform_unsupported',
    );
  }
  return value;
}

function campaignReturnUrl({ platform, returnPath }) {
  const frontend = new URL(process.env.HIVEMIND_FRONTEND_URL || 'https://next.singulancelabs.com');
  const requestedPath = String(returnPath || '/hivemind/app/employees/campaigns');
  if (!requestedPath.startsWith('/hivemind/')) {
    throw providerError('Campaign connection return path is invalid', 400, 'campaign_connection_return_invalid');
  }
  const target = new URL(requestedPath, frontend);
  if (target.origin !== frontend.origin) {
    throw providerError('Campaign connection return path is invalid', 400, 'campaign_connection_return_invalid');
  }
  const publicBase = String(process.env.ZERNIO_CONNECT_CALLBACK_URL || process.env.HIVEMIND_PUBLIC_URL || '').replace(/\/$/, '');
  if (!publicBase) throw providerError('Campaign connection callback is not configured', 503, 'campaign_connection_callback_unavailable');
  const callback = new URL(publicBase.endsWith('/api/campaigns/connections/callback') ? publicBase : `${publicBase}/api/campaigns/connections/callback`);
  callback.searchParams.set('connection_state', signConnectState({
    path: `${target.pathname}${target.search}${target.hash}`,
    platform,
    expires_at: Date.now() + 15 * 60_000,
  }));
  return callback.toString();
}

export function completeCampaignConnectionRedirect(requestUrl) {
  const source = new URL(requestUrl, 'http://localhost');
  const state = verifyConnectState(source.searchParams.get('connection_state'));
  const frontend = new URL(process.env.HIVEMIND_FRONTEND_URL || 'https://next.singulancelabs.com');
  const target = new URL(state.path, frontend);
  if (target.origin !== frontend.origin || !target.pathname.startsWith('/hivemind/')) {
    throw providerError('Campaign connection return path is invalid', 400, 'campaign_connection_return_invalid');
  }
  target.searchParams.set('campaign_connection', state.platform);
  if (source.searchParams.get('error')) target.searchParams.set('campaign_connection_error', 'authorization_failed');
  return target.toString();
}

export async function startCampaignAccountConnection({ prisma, orgId, userId, platform, connectionKind = 'organic', accountRef, returnPath, fetchImpl = globalThis.fetch }) {
  const isAds = connectionKind === 'ads';
  const providerPlatform = normalizePlatform(platform, { ads: isAds });
  let row = await prisma.zernioOrgProfile.findUnique({ where: { orgId } });
  if (!row) {
    await provisionCampaignConnectionState({ prisma, orgId, userId, fetchImpl });
    row = await prisma.zernioOrgProfile.findUnique({ where: { orgId } });
  }
  if (!row) throw providerError('Campaign execution profile is unavailable', 503, 'campaign_profile_unavailable');
  const query = new URLSearchParams({
    profileId: row.zernioProfileId,
    redirect_url: campaignReturnUrl({ platform: providerPlatform, returnPath }),
  });
  if (isAds && providerPlatform === 'twitter') {
    const organicAccounts = (Array.isArray(row.connectedAccounts) ? row.connectedAccounts : [])
      .filter((account) => account.platform === 'twitter' && account.status === 'CONNECTED');
    const selected = accountRef
      ? organicAccounts.find((account) => account.account_ref === accountRef)
      : (organicAccounts.length === 1 ? organicAccounts[0] : null);
    if (!selected) {
      throw providerError(
        organicAccounts.length ? 'Choose the X account that will author promoted posts' : 'Connect an X account before enabling X Ads',
        409,
        organicAccounts.length ? 'campaign_ads_account_selection_required' : 'campaign_organic_connection_required',
        { accounts: organicAccounts.map(({ account_ref, label, username }) => ({ account_ref, label, username })) },
      );
    }
    query.set('accountId', selected.provider_account_id);
  }
  const suffix = isAds ? '/ads' : '';
  const payload = await requestZernio(`/connect/${encodeURIComponent(providerPlatform)}${suffix}?${query}`, { fetchImpl });
  if (payload?.alreadyConnected) {
    return { connected: true, platform: providerPlatform, connection_kind: connectionKind };
  }
  const authorizationUrl = payload?.authUrl || payload?.authorization_url;
  if (!authorizationUrl) throw providerError('Social authorization URL was not returned', 502, 'campaign_connection_url_missing');
  return { authorization_url: authorizationUrl, platform: providerPlatform, connection_kind: connectionKind };
}

export async function disconnectCampaignAccount({ prisma, orgId, accountRef, fetchImpl = globalThis.fetch }) {
  const row = await prisma.zernioOrgProfile.findUnique({ where: { orgId } });
  if (!row) throw providerError('Campaign execution profile was not found', 404, 'campaign_profile_not_found');
  const accounts = Array.isArray(row.connectedAccounts) ? row.connectedAccounts : [];
  const account = accounts.find((candidate) => candidate.account_ref === accountRef);
  if (!account?.provider_account_id) throw providerError('Connected account was not found', 404, 'campaign_account_not_found');
  await requestZernio(`/accounts/${encodeURIComponent(account.provider_account_id)}`, { method: 'DELETE', fetchImpl });
  return syncCampaignConnectionState({ prisma, orgId, fetchImpl });
}

export function resolveCampaignProviderAccount({ row, accountRef, platform }) {
  const accounts = Array.isArray(row?.connectedAccounts) ? row.connectedAccounts : [];
  const candidate = accounts.find((account) => account.account_ref === accountRef);
  if (!candidate || candidate.status !== 'CONNECTED') {
    throw providerError('Connected account was not found', 404, 'campaign_account_not_found');
  }
  if (platform && candidate.platform !== String(platform).trim().toLowerCase()) {
    throw providerError('Connected account does not match the requested platform', 400, 'campaign_account_platform_mismatch');
  }
  return candidate.provider_account_id;
}

async function providerAdAccounts({ row, orgId, accountRef, fetchImpl = globalThis.fetch }) {
  const providerAccountId = resolveCampaignProviderAccount({ row, accountRef });
  const payload = await requestZernio(`/ads/accounts?${new URLSearchParams({ accountId: providerAccountId })}`, { fetchImpl });
  const accounts = (Array.isArray(payload?.accounts) ? payload.accounts : []).filter((account) => account?.id);
  return { providerAccountId, accounts };
}

function publicAdAccount(orgId, providerAccountId, account) {
  return {
    ad_account_ref: adAccountReference(orgId, providerAccountId, account.id),
    name: String(account.name || 'Advertising account').slice(0, 255),
    currency: account.currency ? String(account.currency).slice(0, 3).toUpperCase() : null,
    timezone: account.timezoneName ? String(account.timezoneName).slice(0, 100) : null,
    status: account.status ? String(account.status).slice(0, 40) : null,
    minimum_daily_budget: Number.isFinite(Number(account.minimumDailyBudget)) ? Number(account.minimumDailyBudget) : null,
    selectable: account.selectable !== false,
    unavailable_reason: account.unusableReason ? String(account.unusableReason).slice(0, 300) : null,
  };
}

async function discoverAdAccountCapabilities({ accounts, capabilities, selectedAdAccounts, orgId, fetchImpl }) {
  const selected = selectedAdAccounts && typeof selectedAdAccounts === 'object' && !Array.isArray(selectedAdAccounts)
    ? { ...selectedAdAccounts } : {};
  const discovered = new Map();
  for (const publisher of accounts.filter((account) => account.can_run_ads && account.provider_account_id)) {
    const channels = PLATFORM_CHANNELS[publisher.platform] || [];
    try {
      const payload = await requestZernio(`/ads/accounts?${new URLSearchParams({ accountId: publisher.provider_account_id })}`, { fetchImpl });
      const safeAccounts = (Array.isArray(payload?.accounts) ? payload.accounts : [])
        .filter((account) => account?.id).map((account) => ({
          ...publicAdAccount(orgId, publisher.provider_account_id, account), publisher_account_ref: publisher.account_ref,
        }));
      for (const channel of channels) discovered.set(channel, [...(discovered.get(channel) || []), ...safeAccounts]);
    } catch (error) {
      for (const channel of channels) discovered.set(channel, discovered.get(channel) || []);
    }
  }
  const channelRows = Array.isArray(capabilities.channels) ? capabilities.channels.map((channel) => ({ ...channel })) : [];
  for (const [channel, adAccounts] of discovered) {
    const row = channelRows.find((item) => item.id === channel);
    if (!row) continue;
    let choice = selected[channel];
    const valid = choice && adAccounts.some((account) => account.ad_account_ref === choice.ad_account_ref && account.publisher_account_ref === choice.publisher_account_ref);
    if (!valid) choice = adAccounts.length === 1 ? adAccounts[0] : null;
    if (choice) selected[channel] = choice; else delete selected[channel];
    row.ad_accounts = adAccounts;
    row.selected_ad_account = choice;
    row.executable = Boolean(choice);
    row.execution_ready = Boolean(choice);
    row.reason = choice ? null : (adAccounts.length ? 'select_ad_account' : 'no_usable_ad_account');
    row.execution_reason = row.reason;
  }
  return {
    selectedAdAccounts: selected,
    capabilities: {
      ...capabilities, channels: channelRows,
      can_run_ads: channelRows.some((channel) => ZERNIO_PAID_CHANNEL_PLATFORMS[channel.id] && channel.execution_ready),
    },
  };
}

export async function listCampaignAdAccounts({ prisma, orgId, accountRef, fetchImpl = globalThis.fetch }) {
  const row = await prisma.zernioOrgProfile.findUnique({ where: { orgId } });
  if (!row) throw providerError('Campaign execution profile was not found', 404, 'campaign_profile_not_found');
  const { providerAccountId, accounts } = await providerAdAccounts({ row, orgId, accountRef, fetchImpl });
  return accounts.map((account) => publicAdAccount(orgId, providerAccountId, account));
}

export async function selectCampaignAdAccount({ prisma, orgId, channel, accountRef, adAccountRef, fetchImpl = globalThis.fetch }) {
  const providerPlatform = ZERNIO_PAID_CHANNEL_PLATFORMS[String(channel || '').trim().toLowerCase()];
  if (!providerPlatform) throw providerError('This paid campaign channel is unsupported', 400, 'campaign_ads_channel_unsupported');
  const row = await prisma.zernioOrgProfile.findUnique({ where: { orgId } });
  if (!row) throw providerError('Campaign execution profile was not found', 404, 'campaign_profile_not_found');
  resolveCampaignProviderAccount({ row, accountRef, platform: providerPlatform });
  const resolved = await resolveCampaignAdAccount({ row, orgId, accountRef, adAccountRef, fetchImpl });
  const selectedAdAccounts = {
    ...(row.selectedAdAccounts && typeof row.selectedAdAccounts === 'object' ? row.selectedAdAccounts : {}),
    [channel]: { ...resolved.account, publisher_account_ref: accountRef },
  };
  await prisma.zernioOrgProfile.update({ where: { orgId }, data: { selectedAdAccounts, lastSyncedAt: null } });
  return syncCampaignConnectionState({ prisma, orgId, fetchImpl });
}

export async function resolveCampaignAdAccount({ row, orgId, accountRef, adAccountRef, fetchImpl = globalThis.fetch }) {
  const { providerAccountId, accounts } = await providerAdAccounts({ row, orgId, accountRef, fetchImpl });
  const selectable = accounts.filter((account) => account.selectable !== false);
  const selected = adAccountRef
    ? selectable.find((account) => adAccountReference(orgId, providerAccountId, account.id) === adAccountRef)
    : (selectable.length === 1 ? selectable[0] : null);
  if (!selected) {
    throw providerError(
      selectable.length ? 'Choose the advertising account for this campaign' : 'No usable advertising account is available',
      409,
      selectable.length ? 'campaign_ad_account_selection_required' : 'campaign_ad_account_unavailable',
      { accounts: selectable.map((account) => publicAdAccount(orgId, providerAccountId, account)) },
    );
  }
  return { providerAccountId, providerAdAccountId: String(selected.id), account: publicAdAccount(orgId, providerAccountId, selected) };
}

export const __test = { accountReference, adAccountReference, campaignReturnUrl, capabilitySnapshot, normalizeAccount, publicState, profileName, signConnectState, verifyConnectState, ZERNIO_WEBHOOK_EVENTS };

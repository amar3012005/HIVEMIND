import { X_AUTH_OAUTH1, X_AUTH_OAUTH2 } from '../x-ads/x-auth-store.js';
import { campaignChannelExecutionEnabled, campaignExecutionChannels, campaignsV2Enabled, campaignWorkerEnabled } from './state.js';
import { DEFAULT_CAMPAIGN_IMAGE_MODEL } from './image-provider.js';
import { DAILY_GENERATION_LIMIT } from './image-service.js';

async function hasGmailConnection(prisma, userId, orgId) {
  const [native, legacy] = await Promise.all([
    prisma.nangoConnection.findFirst({
      where: { userId, orgId, providerKey: { in: ['gmail', 'google'] }, status: 'active' },
      select: { providerKey: true, connectedAt: true, updatedAt: true },
    }).catch(() => null),
    prisma.platformIntegration.findFirst({
      where: { userId, platformType: { in: ['gmail', 'google'] }, isActive: true },
      select: { platformType: true, platformDisplayName: true, oauthScopes: true, oauthGrantedAt: true, oauthLastRefreshed: true, tokenExpiresAt: true },
    }).catch(() => null),
  ]);
  if (native) return {
    connected: true, source: 'nango', provider: native.providerKey,
    connected_at: native.connectedAt || null, verified_at: native.updatedAt || null,
  };
  if (legacy) return {
    connected: true, source: 'native_legacy', provider: legacy.platformType,
    account_label: legacy.platformDisplayName || null, scopes: legacy.oauthScopes || [],
    connected_at: legacy.oauthGrantedAt || null, verified_at: legacy.oauthLastRefreshed || null,
    expires_at: legacy.tokenExpiresAt || null,
  };
  return { connected: false, source: null };
}

function isUnexpired(connection, now) {
  return Boolean(connection?.status === 'active' && (
    connection.refreshToken || !connection.expiresAt || connection.expiresAt.getTime() > now.getTime()
  ));
}

function connectionEvidence(connection, authKind, now) {
  if (!connection) return { status: 'not_connected', auth_kind: authKind };
  const active = isUnexpired(connection, now);
  return {
    status: active ? 'connected' : (connection.status === 'active' ? 'expired' : connection.status),
    auth_kind: authKind,
    identity: connection.xUserId ? { id: connection.xUserId, username: connection.xUsername || null } : null,
    scopes: connection.scopes || [],
    connected_at: connection.connectedAt || null,
    verified_at: connection.updatedAt || connection.connectedAt || null,
    expires_at: connection.expiresAt || null,
  };
}

export function campaignCapabilitySnapshot(channel) {
  const { id, planning_ready, connected, executable, execution_ready, reason, execution_reason, evidence } = channel;
  return { id, planning_ready, connected, executable, execution_ready, reason, execution_reason, evidence: evidence || null };
}

export async function getCampaignCapabilities({ prisma, userId, orgId }) {
  const now = new Date();
  const [x, xAds, gmail, tara] = await Promise.all([
    prisma.xAdsCredential.findUnique({
      where: { orgId_userId_authKind: { orgId, userId, authKind: X_AUTH_OAUTH2 } },
      select: { status: true, xUserId: true, xUsername: true, scopes: true, expiresAt: true, connectedAt: true, updatedAt: true, refreshToken: true },
    }).catch(() => null),
    prisma.xAdsCredential.findUnique({
      where: { orgId_userId_authKind: { orgId, userId, authKind: X_AUTH_OAUTH1 } },
      select: { status: true, xUserId: true, xUsername: true, scopes: true, expiresAt: true, connectedAt: true, updatedAt: true },
    }).catch(() => null),
    hasGmailConnection(prisma, userId, orgId),
    prisma.taraRuntimeConfig.findUnique({ where: { orgId }, select: { defaultProvider: true, revision: true, updatedAt: true } }).catch(() => null),
  ]);
  const enabled = campaignsV2Enabled(orgId);
  const xConnected = isUnexpired(x, now);
  const xAdsConnected = isUnexpired(xAds, now);
  const gmailConnected = gmail.connected;
  const adsApproved = process.env.X_ADS_API_APPROVED === 'true';
  const planningOnly = [
    { id: 'x_ads', reason: !adsApproved ? 'awaiting_x_ads_approval' : (xAdsConnected ? 'adapter_not_available' : 'enable_x_ads'), evidence: { ...connectionEvidence(xAds, X_AUTH_OAUTH1, now), api_approved: adsApproved, adapter_available: false } },
    { id: 'google_ads', reason: 'connect_google_ads' },
    { id: 'meta', reason: 'connect_meta_ads' },
    { id: 'linkedin', reason: 'connect_linkedin_ads' },
    { id: 'youtube_ads', reason: 'connect_google_ads' },
    { id: 'tiktok_ads', reason: 'connect_tiktok_ads' },
    { id: 'microsoft_ads', reason: 'connect_microsoft_ads' },
    { id: 'apple_ads', reason: 'connect_apple_ads' },
    { id: 'amazon_ads', reason: 'connect_amazon_ads' },
    { id: 'reddit_ads', reason: 'connect_reddit_ads' },
    { id: 'pinterest_ads', reason: 'connect_pinterest_ads' },
    { id: 'snapchat_ads', reason: 'connect_snapchat_ads' },
  ];
  return {
    checked_at: now.toISOString(),
    enabled, execution_enabled: enabled && campaignWorkerEnabled() && campaignExecutionChannels().size > 0,
    image_generation: { available: Boolean(process.env.OPENROUTER_API_KEY), provider: 'openrouter', model: DEFAULT_CAMPAIGN_IMAGE_MODEL, max_variants: 2, max_upload_bytes: 5 * 1024 * 1024, daily_org_limit: DAILY_GENERATION_LIMIT },
    channels: [
      { id: 'x_organic', planning_ready: enabled, connected: xConnected, executable: enabled && xConnected, execution_ready: enabled && xConnected && campaignChannelExecutionEnabled('x_organic'), reason: xConnected ? null : 'connect_x', execution_reason: campaignChannelExecutionEnabled('x_organic') ? null : 'execution_not_enabled', identity: xConnected ? { id: x.xUserId, username: x.xUsername } : null, evidence: { ...connectionEvidence(x, X_AUTH_OAUTH2, now), adapter_available: true } },
      { id: 'gmail', planning_ready: enabled, connected: gmailConnected, executable: enabled && gmailConnected, execution_ready: enabled && gmailConnected && campaignChannelExecutionEnabled('gmail'), reason: gmailConnected ? null : 'connect_gmail', execution_reason: campaignChannelExecutionEnabled('gmail') ? null : 'execution_not_enabled', evidence: { ...gmail, status: gmailConnected ? 'connected' : 'not_connected', adapter_available: true } },
      { id: 'tara', planning_ready: enabled, connected: Boolean(tara), executable: enabled && Boolean(tara), execution_ready: enabled && Boolean(tara) && campaignChannelExecutionEnabled('tara'), reason: tara ? null : 'configure_tara', execution_reason: campaignChannelExecutionEnabled('tara') ? null : 'execution_not_enabled', provider: tara?.defaultProvider || null, evidence: { status: tara ? 'configured' : 'not_configured', scope: 'organization', provider: tara?.defaultProvider || null, revision: tara?.revision || null, verified_at: tara?.updatedAt || null, adapter_available: true } },
      ...planningOnly.map((channel) => ({
        ...channel,
        planning_ready: enabled,
        connected: channel.id === 'x_ads' ? xAdsConnected : false,
        executable: false,
        execution_ready: false,
        execution_reason: 'adapter_not_available',
        evidence: channel.evidence || { status: 'not_connected', adapter_available: false },
      })),
    ],
  };
}

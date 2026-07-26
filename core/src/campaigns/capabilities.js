import { X_AUTH_OAUTH2 } from '../x-ads/x-auth-store.js';
import { campaignChannelExecutionEnabled, campaignExecutionChannels, campaignsV2Enabled, campaignWorkerEnabled } from './state.js';

async function hasGmailConnection(prisma, userId, orgId) {
  const [native, legacy] = await Promise.all([
    prisma.nangoConnection.findFirst({
      where: { userId, orgId, providerKey: { in: ['gmail', 'google'] }, status: 'active' }, select: { id: true },
    }).catch(() => null),
    prisma.platformIntegration.findFirst({
      where: { userId, platformType: { in: ['gmail', 'google'] }, isActive: true }, select: { id: true },
    }).catch(() => null),
  ]);
  return Boolean(native || legacy);
}

export async function getCampaignCapabilities({ prisma, userId, orgId }) {
  const [x, gmail, tara] = await Promise.all([
    prisma.xAdsCredential.findUnique({
      where: { orgId_userId_authKind: { orgId, userId, authKind: X_AUTH_OAUTH2 } },
      select: { status: true, xUserId: true, xUsername: true, scopes: true },
    }).catch(() => null),
    hasGmailConnection(prisma, userId, orgId),
    prisma.taraRuntimeConfig.findUnique({ where: { orgId }, select: { defaultProvider: true, revision: true } }).catch(() => null),
  ]);
  const enabled = campaignsV2Enabled(orgId);
  const xConnected = x?.status === 'active';
  const adsApproved = process.env.X_ADS_API_APPROVED === 'true';
  return {
    enabled, execution_enabled: enabled && campaignWorkerEnabled() && campaignExecutionChannels().size > 0,
    channels: [
      { id: 'x_organic', connected: xConnected, executable: enabled && xConnected, execution_ready: enabled && xConnected && campaignChannelExecutionEnabled('x_organic'), reason: xConnected ? null : 'connect_x', execution_reason: campaignChannelExecutionEnabled('x_organic') ? null : 'execution_not_enabled', identity: xConnected ? { id: x.xUserId, username: x.xUsername } : null },
      { id: 'gmail', connected: gmail, executable: enabled && gmail, execution_ready: enabled && gmail && campaignChannelExecutionEnabled('gmail'), reason: gmail ? null : 'connect_gmail', execution_reason: campaignChannelExecutionEnabled('gmail') ? null : 'execution_not_enabled' },
      { id: 'tara', connected: Boolean(tara), executable: enabled && Boolean(tara), execution_ready: enabled && Boolean(tara) && campaignChannelExecutionEnabled('tara'), reason: tara ? null : 'configure_tara', execution_reason: campaignChannelExecutionEnabled('tara') ? null : 'execution_not_enabled', provider: tara?.defaultProvider || null },
      { id: 'x_ads', connected: false, executable: false, reason: adsApproved ? 'enable_x_ads' : 'awaiting_x_ads_approval' },
      { id: 'linkedin', connected: false, executable: false, reason: 'no_official_api' },
      { id: 'meta', connected: false, executable: false, reason: 'no_official_api' },
    ],
  };
}

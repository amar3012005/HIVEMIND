import { runGoogleTool } from '../../connectors/google-native.js';
import { outreachDailyCap, outreachKillSwitchActive } from '../../outreach/outreach-contract.js';
import { CampaignAdapterError, publicProviderResponse, requireApproval, requireValue } from './contract.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

async function enforceOutboundLimits(prisma, orgId) {
  if (outreachKillSwitchActive()) {
    throw new CampaignAdapterError('Outbound outreach is paused by the organization kill switch', {
      code: 'outreach_kill_switch', outcome: 'BLOCKED',
    });
  }
  const cap = outreachDailyCap();
  if (!cap) return;
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const sent = await prisma.outboundAction.count({ where: { orgId, channel: 'email', status: 'sent', sentAt: { gte: since } } });
  if (sent >= cap) {
    throw new CampaignAdapterError(`The organization daily outreach cap of ${cap} has been reached`, {
      code: 'outreach_daily_cap', outcome: 'BLOCKED', details: { cap, sent },
    });
  }
}

export const gmailAdapter = {
  channel: 'gmail',
  async execute({ prisma, action, approval, providers = {} }) {
    requireApproval(action, approval);
    const payload = action.payload || {};
    const to = requireValue(payload.to, 'Gmail recipient is required', 'gmail_recipient_required').toLowerCase();
    if (!EMAIL_RE.test(to)) throw new CampaignAdapterError('Gmail recipient must be a valid email address', { code: 'gmail_recipient_invalid', outcome: 'BLOCKED' });
    const subject = requireValue(payload.subject, 'Gmail subject is required', 'gmail_subject_required');
    const body = requireValue(payload.body || payload.final_copy, 'Gmail body is required', 'gmail_body_required');
    await enforceOutboundLimits(prisma, action.campaign.orgId);

    const existing = await prisma.outboundAction.findFirst({
      where: { campaignActionId: action.id, status: 'sent' }, orderBy: { sentAt: 'desc' },
    });
    if (existing) return { externalId: existing.messageId, response: { id: existing.messageId, threadId: existing.threadId, deduplicated: true } };

    const result = await (providers.runGoogleTool || runGoogleTool)('gmail_send', {
      to, subject, body, markdown: true, threadId: payload.thread_id || undefined,
    }, { user_id: action.campaign.ownerUserId, org_id: action.campaign.orgId }, prisma);
    await prisma.outboundAction.create({ data: {
      orgId: action.campaign.orgId,
      userId: action.campaign.ownerUserId,
      roomId: action.campaign.roomId || null,
      campaignId: action.campaignId,
      campaignActionId: action.id,
      approvalId: approval.id,
      channel: 'email', recipient: to, subject,
      messageId: result.id || null, threadId: result.threadId || null,
      status: 'sent', meta: { source: 'campaigns_v2', plan_version_id: action.planVersionId },
    } });
    return { externalId: result.id, response: publicProviderResponse(result) };
  },
  async reconcile({ prisma, action }) {
    const ledger = await prisma.outboundAction.findFirst({ where: { campaignActionId: action.id, status: 'sent' }, orderBy: { sentAt: 'desc' } });
    if (ledger?.messageId) return { status: 'SUCCEEDED', externalId: ledger.messageId, response: { threadId: ledger.threadId, source: 'outbound_ledger' } };
    return { status: 'NEEDS_RECONCILIATION', reason: 'No Gmail message ID exists in the outbound ledger; inspect Sent mail before retrying.' };
  },
};

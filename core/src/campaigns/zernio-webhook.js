import crypto from 'node:crypto';

import { syncCampaignConnectionState } from './zernio-execution.js';

function webhookError(message, status, code) {
  return Object.assign(new Error(message), { status, code });
}

function profileIdFromAccount(account) {
  if (typeof account?.profileId === 'string') return account.profileId;
  return account?.profileId?._id || account?.profile?._id || null;
}

export function verifyZernioWebhook(rawBody, signature, secret = process.env.ZERNIO_WEBHOOK_SECRET) {
  if (!secret) throw webhookError('Campaign webhook is not configured', 503, 'campaign_webhook_not_configured');
  if (!signature) throw webhookError('Campaign webhook signature is required', 401, 'campaign_webhook_signature_missing');
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const supplied = String(signature).trim().toLowerCase();
  const valid = supplied.length === expected.length && crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected));
  if (!valid) throw webhookError('Campaign webhook signature is invalid', 401, 'campaign_webhook_signature_invalid');
}

function profileIdFromPayload(payload) {
  return profileIdFromAccount(payload?.account)
    || (typeof payload?.profileId === 'string' ? payload.profileId : payload?.profileId?._id)
    || profileIdFromAccount(payload?.post)
    || profileIdFromAccount(payload?.ad)
    || null;
}

function externalCandidates(payload) {
  return [...new Set([
    payload?.post?._id, payload?.post?.id, payload?.postId,
    payload?.comment?.postId, payload?.comment?.zernioPostId,
    payload?.ad?._id, payload?.ad?.id, payload?.adId,
    payload?.adObject?._id, payload?.adObject?.id,
  ].map((value) => String(value || '').trim()).filter(Boolean))];
}

function safeProviderEvent(eventType, payload) {
  const comment = payload?.comment || {};
  const lead = payload?.lead || {};
  return {
    event: eventType,
    timestamp: payload?.timestamp || null,
    platform: payload?.account?.platform || payload?.post?.platform || payload?.ad?.platform || null,
    status: payload?.status?.raw || payload?.post?.status || payload?.ad?.status || null,
    error: payload?.error?.message || payload?.error || payload?.post?.error || null,
    comment: eventType === 'comment.received' ? {
      id: comment._id || comment.id || null,
      text: String(comment.text || comment.content || '').slice(0, 2000),
      author: String(comment.author?.name || comment.authorName || comment.username || '').slice(0, 255) || null,
      received_at: comment.createdAt || payload?.timestamp || null,
    } : null,
    lead: eventType === 'lead.received' ? {
      id: lead._id || lead.id || null, form_name: String(lead.formName || '').slice(0, 255) || null,
      created_at: lead.createdAt || payload?.timestamp || null,
    } : null,
  };
}

async function processAcceptedEvent({ prisma, eventId, providerProfileId, eventType, payload }) {
  try {
    if (eventType === 'webhook.test') {
      await prisma.zernioWebhookEvent.update({ where: { id: eventId }, data: { status: 'IGNORED', processedAt: new Date() } });
      return;
    }
    const profile = providerProfileId
      ? await prisma.zernioOrgProfile.findUnique({ where: { zernioProfileId: providerProfileId }, select: { orgId: true } })
      : null;
    if (!profile?.orgId) {
      await prisma.zernioWebhookEvent.update({ where: { id: eventId }, data: { status: 'IGNORED', processedAt: new Date() } });
      return;
    }
    await prisma.zernioWebhookEvent.update({ where: { id: eventId }, data: { orgId: profile.orgId } });
    if (['account.connected', 'account.disconnected', 'account.ads.initial_sync_completed'].includes(eventType)) {
      await syncCampaignConnectionState({ prisma, orgId: profile.orgId });
    }
    const candidates = externalCandidates(payload);
    const action = candidates.length ? await prisma.campaignAction.findFirst({
      where: { externalId: { in: candidates }, campaign: { orgId: profile.orgId } },
      include: { campaign: true },
    }) : null;
    if (action) {
      const eventData = safeProviderEvent(eventType, payload);
      if (eventType === 'post.published') {
        await prisma.campaignAction.update({ where: { id: action.id }, data: { status: 'SUCCEEDED', lastError: null, executedAt: action.executedAt || new Date() } });
      } else if (eventType === 'post.failed' || eventType === 'post.cancelled') {
        await prisma.campaignAction.update({ where: { id: action.id }, data: { status: 'FAILED', lastError: String(eventData.error || `Provider reported ${eventType}`).slice(0, 1000) } });
      } else if (eventType === 'post.partial') {
        await prisma.campaignAction.update({ where: { id: action.id }, data: { status: 'NEEDS_RECONCILIATION', lastError: 'The post completed on only some requested platforms' } });
      }
      await prisma.campaignEvent.create({ data: {
        campaignId: action.campaignId, orgId: profile.orgId, eventType: `campaign_provider_${eventType.replaceAll('.', '_')}`,
        actorType: 'provider', data: { action_id: action.id, ...eventData },
      } });
    }
    await prisma.zernioWebhookEvent.update({ where: { id: eventId }, data: { status: 'PROCESSED', processedAt: new Date() } });
  } catch (error) {
    await prisma.zernioWebhookEvent.update({
      where: { id: eventId }, data: { status: 'FAILED', error: String(error?.message || error).slice(0, 1000), processedAt: new Date() },
    }).catch(() => {});
  }
}

export async function acceptZernioWebhook({ prisma, rawBody, signature, eventIdHeader }) {
  verifyZernioWebhook(rawBody, signature);
  let payload;
  try { payload = JSON.parse(rawBody.toString('utf8')); } catch {
    throw webhookError('Campaign webhook body is invalid', 400, 'campaign_webhook_body_invalid');
  }
  const providerEventId = String(payload?.id || eventIdHeader || '').trim();
  const eventType = String(payload?.event || '').trim();
  if (!providerEventId || !eventType) throw webhookError('Campaign webhook event identity is missing', 400, 'campaign_webhook_identity_missing');
  const providerProfileId = profileIdFromPayload(payload);
  let event;
  try {
    event = await prisma.zernioWebhookEvent.create({
      data: { providerEventId, eventType, providerProfileId, payload, status: 'ACCEPTED' },
    });
  } catch (error) {
    if (error?.code === 'P2002') return { accepted: true, duplicate: true, event_id: providerEventId };
    throw error;
  }
  setImmediate(() => processAcceptedEvent({ prisma, eventId: event.id, providerProfileId, eventType, payload }));
  return { accepted: true, duplicate: false, event_id: providerEventId };
}

export const __test = { externalCandidates, profileIdFromAccount, profileIdFromPayload, processAcceptedEvent, safeProviderEvent };

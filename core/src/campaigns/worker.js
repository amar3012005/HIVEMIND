import crypto from 'node:crypto';
import { createOrganicPost } from '../x-ads/service.js';
import { runGoogleTool } from '../connectors/google-native.js';
import { canonicalHash } from './service.js';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'BLOCKED', 'NEEDS_RECONCILIATION', 'CANCELLED']);

function providerError(error) {
  const message = String(error?.message || error || 'Provider action failed').slice(0, 1000);
  const ambiguous = error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timeout|socket hang up|connection reset/i.test(message);
  return { message, ambiguous, retryableRead: Number(error?.status) === 429 || Number(error?.status) >= 500 };
}

async function executeTara(action) {
  const runtime = await action._prisma.taraRuntimeConfig.findUnique({ where: { orgId: action.campaign.orgId } });
  const provider = runtime?.defaultProvider === 'grok' ? 'grok' : 'deepgram';
  const base = provider === 'grok'
    ? (process.env.HIVEMIND_TARA_GROK_URL || process.env.TARA_GROK_INTERNAL_URL || 'http://tara-grok:8092')
    : (process.env.HIVEMIND_TARA_DEEPGRAM_URL || 'http://tara-deepgram:8091');
  const capability = await fetch(`${base}/capabilities`, { signal: AbortSignal.timeout(5000) }).then((res) => res.ok ? res.json() : null).catch(() => null);
  if (capability && capability.telephony === false) {
    const error = new Error('The selected TARA provider requires this call to be started in the browser');
    error.code = 'browser_required'; throw error;
  }
  const payload = action.payload || {};
  const sessionId = `campaign-${action.id.slice(0, 8)}-${Date.now()}`;
  const response = await fetch(`${base}/calls/outbound`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(provider === 'deepgram' && process.env.TARA_DG_API_KEY ? { 'X-TARA-Key': process.env.TARA_DG_API_KEY } : {}) },
    body: JSON.stringify({
      to: payload.to, session_id: sessionId, user_id: action.campaign.ownerUserId, org_id: action.campaign.orgId,
      goal: [payload.goal, payload.opening ? `Open with: ${payload.opening}` : null, payload.strategy ? `Strategy: ${payload.strategy}` : null].filter(Boolean).join('. ').slice(0, 600),
      context: String(payload.context || '').slice(0, 800) || undefined,
      language: String(payload.language || 'en').slice(0, 8), provider,
      config_revision: runtime?.revision || 1,
    }),
    signal: AbortSignal.timeout(20_000),
  });
  const text = await response.text(); let data;
  try { data = JSON.parse(text); } catch { data = { raw: text.slice(0, 500) }; }
  if (!response.ok) { const error = new Error(data?.error || `TARA outbound failed (${response.status})`); error.status = response.status; throw error; }
  return { externalId: data?.call_leg_id || sessionId, response: { ...data, provider, session_id: sessionId } };
}

async function executeAction(prisma, action) {
  const payload = action.payload || {};
  if (action.channel === 'x_organic') {
    const post = await createOrganicPost({
      prisma, userId: action.campaign.ownerUserId, orgId: action.campaign.orgId,
      text: payload.text || payload.final_copy, confirmed: true,
    });
    return { externalId: post.id, response: post };
  }
  if (action.channel === 'gmail') {
    const result = await runGoogleTool('gmail_send', {
      to: payload.to, subject: payload.subject, body: payload.body || payload.final_copy,
      markdown: true, threadId: payload.thread_id || undefined,
    }, { user_id: action.campaign.ownerUserId, org_id: action.campaign.orgId }, prisma);
    return { externalId: result.id, response: result };
  }
  if (action.channel === 'tara') return executeTara({ ...action, _prisma: prisma });
  const error = new Error(`No campaign adapter for ${action.channel}`); error.code = 'adapter_missing'; throw error;
}

async function leaseAction(prisma, { campaignId, workerId, leaseSeconds }) {
  const campaignFilter = campaignId ? 'AND a."campaign_id" = $3::uuid' : '';
  const params = campaignId ? [workerId, leaseSeconds, campaignId] : [workerId, leaseSeconds];
  const rows = await prisma.$queryRawUnsafe(
    `WITH candidate AS (
       SELECT a.id FROM "hivemind"."campaign_actions" a
       JOIN "hivemind"."campaigns" c ON c.id = a."campaign_id"
       WHERE a.status = 'QUEUED' AND a."scheduled_at" <= now()
         AND (a."lease_expires_at" IS NULL OR a."lease_expires_at" < now())
         AND c.status = 'RUNNING' AND c."approved_plan_version_id" = a."plan_version_id"
         ${campaignFilter}
       ORDER BY a."scheduled_at", a.position
       FOR UPDATE SKIP LOCKED LIMIT 1
     )
     UPDATE "hivemind"."campaign_actions" a
        SET status = 'EXECUTING', "lease_owner" = $1,
            "lease_expires_at" = now() + ($2::text || ' seconds')::interval,
            "updated_at" = now()
       FROM candidate WHERE a.id = candidate.id RETURNING a.id`,
    ...params,
  );
  return rows?.[0]?.id || null;
}

async function finishCampaignIfDone(prisma, campaignId) {
  const remaining = await prisma.campaignAction.count({ where: { campaignId, status: { notIn: [...TERMINAL] } } });
  if (remaining) return;
  const failed = await prisma.campaignAction.count({ where: { campaignId, status: { in: ['FAILED', 'BLOCKED', 'NEEDS_RECONCILIATION'] } } });
  const campaign = await prisma.campaign.update({ where: { id: campaignId }, data: { status: failed ? 'FAILED' : 'COMPLETED', completedAt: new Date() } });
  await prisma.campaignChannel.updateMany({ where: { campaignId }, data: { status: failed ? 'FAILED' : 'COMPLETED' } });
  await prisma.campaignEvent.create({ data: { campaignId, orgId: campaign.orgId, eventType: failed ? 'campaign_execution_failed' : 'campaign_completed', data: { failed_actions: failed } } });
}

export async function processDueCampaignActions({ prisma, campaignId = null, limit = 10, workerId = `campaign-${crypto.randomUUID()}` }) {
  if (!prisma) return { processed: 0 };
  let processed = 0;
  while (processed < Math.max(1, Math.min(Number(limit) || 10, 50))) {
    const actionId = await leaseAction(prisma, { campaignId, workerId, leaseSeconds: 120 });
    if (!actionId) break;
    const action = await prisma.campaignAction.findUnique({ where: { id: actionId }, include: { campaign: true, attempts: { orderBy: { attempt: 'desc' }, take: 1 } } });
    if (!action) continue;
    const attemptNumber = (action.attempts[0]?.attempt || 0) + 1;
    const attempt = await prisma.campaignActionAttempt.create({ data: { actionId, attempt: attemptNumber, requestHash: canonicalHash(action.payload) } });
    try {
      const result = await executeAction(prisma, action);
      await prisma.$transaction([
        prisma.campaignActionAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED', externalId: result.externalId || null, response: result.response || {}, completedAt: new Date() } }),
        prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'SUCCEEDED', externalId: result.externalId || null, executedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null } }),
        prisma.campaignEvent.create({ data: { campaignId: action.campaignId, orgId: action.campaign.orgId, eventType: 'campaign_action_succeeded', data: { action_id: actionId, channel: action.channel, external_id: result.externalId || null } } }),
      ]);
    } catch (error) {
      const normalized = providerError(error);
      const status = error?.code === 'browser_required' ? 'BLOCKED' : (normalized.ambiguous ? 'NEEDS_RECONCILIATION' : 'FAILED');
      await prisma.$transaction([
        prisma.campaignActionAttempt.update({ where: { id: attempt.id }, data: { status, error: normalized.message, completedAt: new Date() } }),
        prisma.campaignAction.update({ where: { id: actionId }, data: { status, lastError: normalized.message, leaseOwner: null, leaseExpiresAt: null } }),
        prisma.campaignEvent.create({ data: { campaignId: action.campaignId, orgId: action.campaign.orgId, eventType: 'campaign_action_failed', data: { action_id: actionId, channel: action.channel, status, error: normalized.message, automatic_retry: false } } }),
      ]);
    }
    processed += 1;
    await finishCampaignIfDone(prisma, action.campaignId);
  }
  return { processed };
}

import crypto from 'node:crypto';
import { executeCampaignAction } from './adapters/index.js';
import { canonicalHash } from './service.js';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'BLOCKED', 'NEEDS_RECONCILIATION', 'CANCELLED']);

function providerError(error) {
  const message = String(error?.message || error || 'Provider action failed').slice(0, 1000);
  const ambiguous = error?.name === 'TimeoutError' || error?.name === 'AbortError' || /timeout|socket hang up|connection reset/i.test(message);
  return { message, ambiguous, retryableRead: Number(error?.status) === 429 || Number(error?.status) >= 500 };
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

export async function processDueCampaignActions({ prisma, campaignId = null, limit = 10, workerId = `campaign-${crypto.randomUUID()}`, providers = {} }) {
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
      const approval = await prisma.campaignApproval.findFirst({ where: {
        campaignId: action.campaignId, planVersionId: action.planVersionId, status: 'ACTIVE',
      }, orderBy: { approvedAt: 'desc' } });
      if (!approval?.caps?.action_hashes || approval.caps.action_hashes[action.id] !== canonicalHash(action.payload)) {
        const error = new Error('The action payload no longer matches the approved campaign plan');
        error.code = 'campaign_action_changed'; error.outcome = 'BLOCKED'; throw error;
      }
      const result = await executeCampaignAction({ prisma, action, approval, providers, executionAttempt: attemptNumber });
      await prisma.$transaction([
        prisma.campaignActionAttempt.update({ where: { id: attempt.id }, data: { status: 'SUCCEEDED', externalId: result.externalId || null, response: result.response || {}, completedAt: new Date() } }),
        prisma.campaignAction.update({ where: { id: actionId }, data: { status: 'SUCCEEDED', externalId: result.externalId || null, executedAt: new Date(), leaseOwner: null, leaseExpiresAt: null, lastError: null } }),
        prisma.campaignEvent.create({ data: { campaignId: action.campaignId, orgId: action.campaign.orgId, eventType: 'campaign_action_succeeded', data: { action_id: actionId, channel: action.channel, external_id: result.externalId || null } } }),
      ]);
    } catch (error) {
      const normalized = providerError(error);
      const status = error?.outcome || (normalized.ambiguous ? 'NEEDS_RECONCILIATION' : 'FAILED');
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

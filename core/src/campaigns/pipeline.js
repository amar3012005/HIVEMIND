import { markCampaignNeedsInput, persistCampaignBundle } from './service.js';
import { normalizeCampaignRoomEvent } from './contracts.js';

const FINAL_RUN_STATES = new Set(['COMPLETED', 'NEEDS_INPUT', 'FAILED', 'CANCELLED']);

async function markGenerationStarted(prisma, run) {
  const claimed = await prisma.campaignRun.updateMany({
    where: { id: run.id, status: 'DISPATCHING' },
    data: { status: 'RUNNING', error: null },
  });
  if (!claimed.count) return;
  await prisma.campaignEvent.create({ data: {
    campaignId: run.campaignId,
    orgId: run.campaign.orgId,
    eventType: 'campaign_generation_started',
    data: { room_id: run.roomId, turn_id: run.turnId },
  } });
}

async function markGenerationFailed(prisma, run, event) {
  const status = String(event.status || 'failed').toLowerCase();
  const needsInput = ['blocked', 'disabled', 'cost_capped', 'escalated'].includes(status);
  const campaignStatus = needsInput ? 'NEEDS_INPUT' : 'FAILED';
  const message = String(event.error || event.message || `Campaign Room sealed with status ${status}`).slice(0, 2000);
  await prisma.$transaction([
    prisma.campaignRun.update({ where: { id: run.id }, data: {
      status: campaignStatus, error: message, completedAt: new Date(),
      validation: { valid: false, errors: [message], room_status: status },
    } }),
    prisma.campaign.update({ where: { id: run.campaignId }, data: { status: campaignStatus, lastError: message } }),
    prisma.campaignChannel.updateMany({ where: { campaignId: run.campaignId }, data: { status: campaignStatus } }),
    prisma.campaignEvent.create({ data: {
      campaignId: run.campaignId, orgId: run.campaign.orgId,
      eventType: needsInput ? 'campaign_generation_needs_input' : 'campaign_generation_failed',
      data: { room_id: run.roomId, turn_id: run.turnId, room_status: status, error: message },
    } }),
  ]);
  return { campaignId: run.campaignId, status: campaignStatus };
}

export async function handleCampaignRoomEvent({ prisma, turnId, event }) {
  const normalized = normalizeCampaignRoomEvent(event);
  if (!normalized) return null;
  const run = await prisma.campaignRun.findUnique({ where: { turnId }, include: { campaign: true } });
  if (!run) return null;

  if (!FINAL_RUN_STATES.has(run.status) && normalized.t !== 'seal') await markGenerationStarted(prisma, run);
  if (normalized.t === 'campaign_bundle') {
    return persistCampaignBundle({ prisma, turnId, bundle: normalized.bundle });
  }
  if (normalized.t === 'campaign_bundle_invalid') {
    return markCampaignNeedsInput({ prisma, turnId, errors: normalized.errors });
  }
  if (normalized.t !== 'seal') return { campaignId: run.campaignId, status: 'RUNNING' };

  const current = await prisma.campaignRun.findUnique({ where: { id: run.id } });
  if (!current || FINAL_RUN_STATES.has(current.status)) return { campaignId: run.campaignId, status: current?.status || run.status };
  if (String(normalized.status || 'complete').toLowerCase() === 'complete') {
    return markCampaignNeedsInput({
      prisma,
      turnId,
      errors: ['Campaign Room completed without submitting a valid campaign plan. Retry generation or provide the missing campaign details.'],
    });
  }
  return markGenerationFailed(prisma, run, normalized);
}

export async function handleCampaignDispatchError({ prisma, campaignId, error }) {
  const run = await prisma.campaignRun.findFirst({
    where: { campaignId }, orderBy: { createdAt: 'desc' }, include: { campaign: true },
  });
  if (!run || FINAL_RUN_STATES.has(run.status) || run.campaign.currentPlanVersionId) {
    return { campaignId, ignored: true };
  }
  const message = String(error?.message || error || 'Campaign Room dispatch failed').slice(0, 2000);
  const definitive = error?.definitive === true && run.status === 'DISPATCHING';
  if (definitive) return markGenerationFailed(prisma, run, { status: 'failed', error: message });
  await prisma.$transaction([
    prisma.campaignRun.update({ where: { id: run.id }, data: { error: message } }),
    prisma.campaignEvent.create({ data: {
      campaignId, orgId: run.campaign.orgId, eventType: 'campaign_dispatch_transport_error',
      data: { room_id: run.roomId, turn_id: run.turnId, error: message, generation_may_continue: true },
    } }),
  ]);
  return { campaignId, status: run.status, ambiguous: true };
}

import { appendHqEvent, scheduleHqWake } from '../hq-runtime/repository.js';

async function runtimeCampaignLink({ prisma, campaignId }) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId },
    select: { id: true, orgId: true, sourceType: true, sourceId: true },
  });
  if (campaign?.sourceType !== 'runtime_playbook' || !campaign.sourceId) return null;
  const run = await prisma.runtimePlaybookRun.findFirst({ where: { id: campaign.sourceId, orgId: campaign.orgId } });
  if (!run) return null;
  const trigger = run.trigger && typeof run.trigger === 'object' ? run.trigger : {};
  if (!trigger.runtime_id || !trigger.runtime_epoch) return null;
  return { campaign, run, trigger };
}

export async function notifyRuntimeCampaignProjection({ prisma, campaignId, type, data = {} }) {
  const link = await runtimeCampaignLink({ prisma, campaignId });
  if (!link) return null;
  const { campaign, run, trigger } = link;
  const identity = data.asset_id || data.plan_version_id || data.event_id || run.checkpointSequence;
  const waitingForCapacity = type === 'campaign.visuals_waiting';
  return appendHqEvent({
    prisma,
    runtimeId: trigger.runtime_id,
    orgId: campaign.orgId,
    runtimeEpoch: trigger.runtime_epoch,
    eventType: 'campaign_artifact_progress',
    title: type === 'campaign.asset_ready'
      ? 'A campaign visual is ready'
      : waitingForCapacity
        ? 'Campaign visuals are waiting for capacity'
        : 'Campaign posts are rendering',
    summary: type === 'campaign.asset_ready'
      ? 'Runtime refreshed the persisted post frame with its generated visual.'
      : waitingForCapacity
        ? 'The accepted campaign, captions, and schedule remain retained. Image generation will resume automatically when capacity is available.'
        : 'The campaign contract is ready and its post visuals are being generated.',
    details: { campaign_id: campaign.id, run_id: run.id, type, ...data },
    idempotencyKey: `runtime-campaign-projection:${campaign.id}:${type}:${identity}`.slice(0, 180),
  });
}

export async function scheduleRuntimeCampaignEvent({ prisma, campaignId, type, data = {} }) {
  const link = await runtimeCampaignLink({ prisma, campaignId });
  if (!link) return null;
  const { campaign, run, trigger } = link;
  const eventId = `campaign:${campaign.id}:${type}:${data.event_id || data.plan_version_id || data.asset_id || run.checkpointSequence}`;
  return scheduleHqWake({
    prisma,
    runtimeId: trigger.runtime_id,
    orgId: campaign.orgId,
    runtimeEpoch: trigger.runtime_epoch,
    idempotencyKey: `runtime-campaign-event:${eventId}`.slice(0, 180),
    triggerType: 'runtime_playbook_event',
    dueAt: new Date(),
    payload: { run_id: run.id, event: { id: eventId, type, data: { ...data, correlation_ref: campaign.id, campaign_id: campaign.id } } },
  });
}

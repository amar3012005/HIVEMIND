import crypto from 'node:crypto';
import { getCampaignCapabilities } from '../../campaigns/capabilities.js';
import { dispatchCampaignRoomSafely } from '../../campaigns/dispatcher.js';
import {
  approveCampaign, createCampaign, getCampaign, resolveHyperagentsOrganicChannels, syncCampaignMetrics,
} from '../../campaigns/service.js';

const ORGANIC = new Set(['x_organic', 'linkedin', 'instagram', 'facebook', 'tiktok', 'youtube', 'pinterest', 'reddit', 'threads', 'bluesky', 'google_business']);

function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }
function asArray(value) { return Array.isArray(value) ? value : []; }
function artifactId(prefix, ...parts) {
  return `${prefix}-${crypto.createHash('sha256').update(parts.map(String).join('\u0000')).digest('hex').slice(0, 32)}`;
}
function value(input, key) { return input?.inputs?.[key]; }
function campaignRef(input) {
  return asArray(value(input, 'artifacts.campaign_record'))[0]?.data?.campaign_id
    || asArray(value(input, 'artifacts.campaign_status'))[0]?.data?.campaign_id
    || asArray(value(input, 'artifacts.campaign_launch_status'))[0]?.data?.campaign_id;
}
function capabilityForChannel(channel) {
  const value = String(channel || '').toLowerCase();
  if (['x_organic', 'x_ads'].includes(value)) return 'x';
  if (['linkedin', 'linkedin_ads'].includes(value)) return 'linkedin';
  if (['instagram'].includes(value)) return 'instagram';
  if (['facebook', 'meta'].includes(value)) return 'facebook';
  if (['tiktok', 'tiktok_ads'].includes(value)) return 'tiktok';
  if (['youtube', 'youtube_ads', 'google_ads'].includes(value)) return 'youtube';
  if (['pinterest', 'pinterest_ads'].includes(value)) return 'pinterest';
  return value || null;
}
async function syncCapabilityRequests(prisma, context, campaign, unavailable) {
  const run = await prisma.runtimePlaybookRun.findFirst({ where: { id: context.runId, orgId: context.orgId }, select: { trigger: true } });
  const todoId = String(run?.trigger?.todo_id || '');
  if (!todoId) return [];
  const todo = await prisma.hqTodo.findFirst({ where: { id: todoId, orgId: context.orgId } });
  if (!todo) return [];
  const missing = [...new Set(unavailable.filter((row) => !row.connected).map((row) => capabilityForChannel(row.id)).filter(Boolean))];
  const previous = Array.isArray(todo.context?.runtime_required_capabilities) ? todo.context.runtime_required_capabilities : [];
  if (!missing.length) {
    await prisma.$transaction([
      prisma.hqCapabilityRequest.updateMany({
        where: { runtimeId: todo.runtimeId, todoId: todo.id, status: 'REQUIRED', capability: { in: previous } },
        data: { status: 'RESOLVED', resolvedAt: new Date() },
      }),
      prisma.hqTodo.update({ where: { id: todo.id }, data: {
        status: todo.status === 'WAITING_FOR_CONNECTOR' ? 'RUNNING' : todo.status,
        blockedReason: null,
        context: { ...(todo.context || {}), runtime_required_capabilities: [] },
      } }),
    ]);
    return [];
  }
  await prisma.hqTodo.update({ where: { id: todo.id }, data: {
    status: 'WAITING_FOR_CONNECTOR',
    blockedReason: `Missing launch capabilities: ${missing.join(', ')}`,
    context: { ...(todo.context || {}), runtime_required_capabilities: missing, runtime_capability_run_id: context.runId },
  } });
  for (const capability of missing) {
    const existing = await prisma.hqCapabilityRequest.findFirst({
      where: { runtimeId: todo.runtimeId, todoId: todo.id, capability, status: 'REQUIRED' },
    });
    if (!existing) await prisma.hqCapabilityRequest.create({ data: {
      runtimeId: todo.runtimeId,
      orgId: context.orgId,
      todoId: todo.id,
      capability,
      provider: capability,
      reason: `${campaign.name} is prepared and retained. Connect ${capability} so its approved channel actions can launch without rebuilding the Campaign Contract.`,
      connectPath: `/hivemind/app/employees/campaigns?connect=${encodeURIComponent(capability)}`,
    } });
  }
  return missing;
}
async function owner(prisma, context) {
  const room = await prisma.hyperRoom.findFirst({ where: { id: context.roomId, orgId: context.orgId }, select: { userId: true } });
  if (!room?.userId) throw new Error('runtime_campaign_owner_not_found');
  return room.userId;
}
function statusArtifact(context, key, campaign, extra = {}) {
  return {
    id: artifactId(key, context.runId, campaign.id, campaign.updatedAt || campaign.status, JSON.stringify(extra)),
    key, status: 'READY', external_ref: campaign.id,
    source_refs: [`campaign:${campaign.id}`, ...(campaign.currentPlanVersionId ? [`campaign-plan:${campaign.currentPlanVersionId}`] : [])],
    data: { campaign_id: campaign.id, correlation_ref: campaign.id, state: campaign.status, plan_version_id: campaign.currentPlanVersionId || null, ...extra },
  };
}

export function createCampaignRuntimeAdapter({ prisma } = {}) {
  if (!prisma) throw new Error('runtime_campaign_prisma_required');
  return {
    id: 'campaigns',
    name: 'Campaign operations',
    description: 'Creates, launches, verifies and observes tenant-scoped Campaign Intelligence executions.',
    async execute(input, context) {
      const action = String(input?.config?.action || 'inspect_contract');
      const userId = await owner(prisma, context);
      if (action === 'create_campaign') {
        const request = asObject(value(input, 'context.request'));
        const target = asObject(value(input, 'context.target'));
        const baseline = asObject(value(input, 'context.baseline'));
        const capabilities = await getCampaignCapabilities({ prisma, userId, orgId: context.orgId });
        const connected = resolveHyperagentsOrganicChannels([], capabilities);
        const planningFallback = capabilities.channels
          .filter((item) => ORGANIC.has(item.id) && item.planning_ready)
          .map((item) => item.id).slice(0, 2);
        const channels = connected.length ? connected : planningFallback;
        if (!channels.length) throw new Error('runtime_campaign_no_plannable_organic_channel');
        const instruction = String(request.instruction || request.objective || 'Create a focused awareness campaign').trim();
        const destinationUrl = String(
          baseline?.company?.website || baseline?.website?.url || value(input, 'context.company')?.website || '',
        ).trim();
        const result = await createCampaign({ prisma, userId, orgId: context.orgId, body: {
          name: 'First Growth Sprint awareness campaign',
          goal: instruction,
          objective: 'AWARENESS',
          channels,
          duration_days: Number(target.duration_days || 7),
          intensity: 'FOCUSED',
          geography: [target.location || baseline?.company?.location].filter(Boolean),
          ...(destinationUrl ? { destination_url: destinationUrl } : {}),
          success_metrics: ['Impressions', 'Engagements', 'Clicks'],
          audience: { mode: 'existing_first', discover_if_insufficient: false },
          brand_constraints: 'Use only claims directly supported by retained evidence. Prefer the exact evidenced wording GDPR-native; do not substitute compliant, certified, guaranteed, only, always, or never unless the cited evidence uses that exact term.',
          prohibited_claims: 'Unsupported compliance, certification, exclusivity, guarantee, and performance claims.',
          autonomy_mode: 'APPROVE_PLAN_ONCE',
          trigger_surface: 'runtime',
          idempotency_key: `runtime-campaign:${context.runId}`,
          source_type: 'runtime_playbook', source_id: context.runId,
          runtime_link: {
            run_id: context.runId, stage_id: context.stageId,
            checkpoint_sequence: input?.checkpoint_sequence || null,
            attempt: input?.attempt || null,
          },
        } });
        if (result.dispatch) dispatchCampaignRoomSafely({ prisma, campaignId: result.campaign.id, dispatch: result.dispatch }).catch(() => {});
        return { artifacts: [statusArtifact(context, 'campaign_record', result.campaign, { channels, room_id: result.campaign.roomId, created: result.created })] };
      }
      const id = campaignRef(input) || value(input, 'event')?.data?.campaign_id;
      if (!id) throw new Error('runtime_campaign_reference_required');
      if (action === 'launch') {
        try {
          const launched = await approveCampaign({ prisma, orgId: context.orgId, userId, id });
          const campaign = await getCampaign({ prisma, orgId: context.orgId, userId, id });
          return { artifacts: [statusArtifact(context, 'campaign_launch_status', campaign, { outcome: 'launched', approval_id: launched.approval.id, action_count: launched.launch.action_count })] };
        } catch (error) {
          const campaign = await getCampaign({ prisma, orgId: context.orgId, userId, id });
          return { artifacts: [statusArtifact(context, 'campaign_launch_status', campaign, { outcome: 'blocked', reason: String(error?.message || error).slice(0, 1000) })], warnings: [String(error?.message || error)] };
        }
      }
      if (action === 'preflight_launch') {
        const campaign = await getCampaign({ prisma, orgId: context.orgId, userId, id });
        const capabilities = await getCampaignCapabilities({ prisma, userId: campaign.ownerUserId, orgId: context.orgId });
        const byId = new Map(capabilities.channels.map((channel) => [channel.id, channel]));
        const unavailable = (campaign.requestedChannels || []).map((channel) => byId.get(channel) || {
          id: channel, connected: false, execution_ready: false, reason: 'connect_account', execution_reason: 'adapter_not_available',
        }).filter((channel) => !channel.execution_ready);
        const missing = await syncCapabilityRequests(prisma, context, campaign, unavailable);
        const unsupported = unavailable.filter((channel) => channel.connected).map((channel) => ({
          channel: channel.id, reason: channel.execution_reason || channel.reason || 'execution_unavailable',
        }));
        return { artifacts: [statusArtifact(context, 'campaign_capability_status', campaign, {
          all_ready: unavailable.length === 0,
          waiting_for_connection: missing.length > 0,
          missing_capabilities: missing,
          unavailable_channels: unavailable.map((channel) => channel.id),
          unsupported_channels: unsupported,
        })] };
      }
      if (action === 'observe') {
        const campaign = await getCampaign({ prisma, orgId: context.orgId, userId, id });
        return { artifacts: [statusArtifact(context, 'campaign_observation', campaign, { subscription: 'campaign-events' })] };
      }
      if (action === 'evaluate') {
        await syncCampaignMetrics({ prisma, orgId: context.orgId, userId, id }).catch(() => null);
        const campaign = await getCampaign({ prisma, orgId: context.orgId, userId, id });
        const snapshots = await prisma.campaignMetricSnapshot.findMany({ where: { campaignId: id }, orderBy: { capturedAt: 'desc' }, take: 20 });
        return { artifacts: [statusArtifact(context, 'campaign_outcome', campaign, { outcome: 'reviewed', metric_snapshot_count: snapshots.length })] };
      }
      const campaign = await getCampaign({ prisma, orgId: context.orgId, userId, id });
      const actions = campaign.actions || [];
      const run = await prisma.runtimePlaybookRun.findFirst({
        where: { id: context.runId, orgId: context.orgId }, select: { context: true },
      });
      const requiredAssets = actions.filter((item) => item.payload?.creative_brief?.required === true);
      const assetsReady = requiredAssets.every((item) => item.payload?.asset_id);
      const contractState = campaign.status === 'READY_FOR_APPROVAL' && assetsReady ? 'ready'
        : campaign.status === 'READY_FOR_APPROVAL' ? 'waiting_assets'
          : campaign.status === 'NEEDS_INPUT' ? 'needs_input'
            : campaign.status === 'FAILED' ? 'failed'
              : campaign.status === 'CANCELLED' ? 'cancelled' : 'preparing';
      return { artifacts: [statusArtifact(context, 'campaign_status', campaign, {
        contract_state: contractState, action_count: actions.length,
        delivery_requested: run?.context?.request?.external_action_requested === true,
        exact_gaps: campaign.lastError ? [String(campaign.lastError).slice(0, 2000)] : [],
        required_asset_count: requiredAssets.length,
        ready_asset_count: requiredAssets.filter((item) => item.payload?.asset_id).length,
      })] };
    },
  };
}

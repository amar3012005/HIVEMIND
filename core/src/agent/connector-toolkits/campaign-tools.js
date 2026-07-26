import crypto from 'node:crypto';
import { getCampaignCapabilities } from '../../campaigns/capabilities.js';
import { dispatchCampaignRoomSafely } from '../../campaigns/dispatcher.js';
import { enqueueCampaignImages } from '../../campaigns/image-service.js';
import {
  controlCampaign,
  createCampaign,
  getCampaign,
  listCampaigns,
  regenerateCampaign,
  syncCampaignMetrics,
} from '../../campaigns/service.js';

export const CAMPAIGN_TOOL_GROUP = 'campaigns';

const uuidSchema = { type: 'string', pattern: '^[0-9a-fA-F-]{36}$' };
const toolDefinitions = [
  {
    name: 'campaign_capabilities', readOnly: true,
    description: 'Check which campaign channels are connected and executable for the current user and organization.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'campaign_create', readOnly: false,
    description: 'Start a new AI campaign. Creates a tenant-scoped campaign and dedicated Campaign Room, then dispatches the specialist agents. This plans the campaign but never publishes external actions.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        goal: { type: 'string', description: 'The concrete business outcome the campaign must accomplish.' },
        name: { type: 'string', description: 'Optional concise campaign name.' },
        objective: { type: 'string', enum: ['AWARENESS', 'PRODUCT_LAUNCH', 'LEAD_GENERATION', 'WEBSITE_TRAFFIC', 'THOUGHT_LEADERSHIP', 'EVENT_PROMOTION', 'RE_ENGAGEMENT', 'CUSTOM'] },
        channels: { type: 'array', items: { type: 'string', enum: ['x_organic', 'gmail', 'tara'] }, description: 'Requested channels. Omit to use every currently executable campaign channel.' },
        duration_days: { type: 'integer', minimum: 1, maximum: 365, description: 'Campaign horizon in days. Usually 7, 14, or 30.' },
        intensity: { type: 'string', enum: ['LIGHT', 'FOCUSED', 'HIGH'] },
        autonomy_mode: { type: 'string', enum: ['APPROVE_PLAN_ONCE', 'REVIEW_EVERY_ACTION'] },
        offer: { type: 'string' }, cta: { type: 'string' }, destination_url: { type: 'string' },
        geography: { type: 'array', items: { type: 'string' } },
        languages: { type: 'array', items: { type: 'string' } },
        brand_constraints: { type: 'string' }, prohibited_claims: { type: 'string' },
        success_metrics: { type: 'array', items: { type: 'string' } },
      },
      required: ['goal'],
    },
  },
  {
    name: 'campaign_list', readOnly: true,
    description: 'List campaigns owned by the current organization, including status, channels, Room, and action count.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'campaign_get', readOnly: true,
    description: 'Get the current status and operating-plan summary for one campaign in the current organization.',
    parameters: { type: 'object', additionalProperties: false, properties: { campaign_id: uuidSchema }, required: ['campaign_id'] },
  },
  {
    name: 'campaign_image_generate', readOnly: false,
    description: 'Generate one or two approval-ready image variants for a specific ready campaign action. Use only when a visual materially improves that action. This queues generation and never publishes the campaign.',
    parameters: {
      type: 'object', additionalProperties: false,
      properties: {
        campaign_id: uuidSchema, action_id: uuidSchema,
        creative_brief: {
          type: 'object', additionalProperties: false,
          properties: {
            required: { type: 'boolean' }, objective: { type: 'string' }, subject: { type: 'string' }, composition: { type: 'string' },
            brand_style: { type: 'string' }, audience: { type: 'string' }, aspect_ratio: { type: 'string', enum: ['1:1', '16:9', '9:16', '4:3', '3:4'] },
            text_policy: { type: 'string' }, required_elements: { type: 'array', items: { type: 'string' } }, forbidden_elements: { type: 'array', items: { type: 'string' } },
            unsupported_claims: { type: 'array', items: { type: 'string' } }, alt_text: { type: 'string' }, generation_prompt: { type: 'string' }, rationale: { type: 'string' },
          },
          required: ['required', 'objective', 'subject', 'composition', 'brand_style', 'audience', 'aspect_ratio', 'text_policy', 'required_elements', 'forbidden_elements', 'unsupported_claims', 'alt_text', 'generation_prompt'],
        },
        variant_count: { type: 'integer', minimum: 1, maximum: 2 },
      },
      required: ['campaign_id', 'action_id'],
    },
  },
  {
    name: 'campaign_regenerate', readOnly: false,
    description: 'Send improvement feedback through the same dedicated Campaign Room and build a new plan version. Does not publish.',
    parameters: { type: 'object', additionalProperties: false, properties: { campaign_id: uuidSchema, feedback: { type: 'string' } }, required: ['campaign_id', 'feedback'] },
  },
  {
    name: 'campaign_pause', readOnly: false,
    description: 'Pause a running campaign in the current organization. This is a safety-reducing control and does not approve or publish new actions.',
    parameters: { type: 'object', additionalProperties: false, properties: { campaign_id: uuidSchema }, required: ['campaign_id'] },
  },
  {
    name: 'campaign_sync', readOnly: true,
    description: 'Refresh and return campaign delivery state and performance metrics without creating or publishing actions.',
    parameters: { type: 'object', additionalProperties: false, properties: { campaign_id: uuidSchema }, required: ['campaign_id'] },
  },
];

function compactCampaign(campaign) {
  return {
    campaign_id: campaign.id,
    name: campaign.name,
    goal: campaign.goal,
    objective: campaign.objective,
    status: campaign.status,
    channels: campaign.requestedChannels || campaign.channels?.map((item) => item.channel) || [],
    room_id: campaign.roomId || null,
    action_count: campaign._count?.actions ?? campaign.actions?.length ?? 0,
    created_at: campaign.createdAt || null,
    updated_at: campaign.updatedAt || null,
  };
}

function navigation(campaign) {
  return {
    campaign_url: `/hivemind/app/employees/campaigns?campaign=${campaign.id}`,
    room_url: campaign.roomId ? `/hivemind/app/employees/rooms/${campaign.roomId}?campaignReturn=${campaign.id}` : null,
  };
}

function requestKey(args, ctx) {
  const traceId = String(ctx?._trace?.traceId || ctx?.turnId || ctx?.turn_id || '').trim();
  if (traceId) return `campaign-tool:${traceId}`.slice(0, 160);
  const stable = JSON.stringify({ goal: args.goal, objective: args.objective, channels: args.channels, duration_days: args.duration_days });
  return `campaign-tool:${crypto.createHash('sha256').update(stable).digest('hex')}`.slice(0, 160);
}

async function auditCampaignTool(prisma, { userId, orgId, campaignId, action, ctx }) {
  if (!prisma?.auditLog || !campaignId) return;
  await prisma.auditLog.create({ data: {
    userId,
    organizationId: orgId,
    eventType: `campaign.${action}`,
    eventCategory: 'data_modification',
    resourceType: 'campaign',
    resourceId: campaignId,
    action,
    actorType: 'user',
    platformType: ctx?.roomId || ctx?.room_id ? 'hyperagents' : 'chat',
    metadata: {
      campaign_id: campaignId,
      source_room_id: ctx?.roomId || ctx?.room_id || null,
      source_turn_id: ctx?.turnId || ctx?.turn_id || null,
      trace_id: ctx?._trace?.traceId || null,
      tool: true,
    },
  } }).catch(() => {});
}

async function resolveChannels({ prisma, userId, orgId, channels }) {
  if (Array.isArray(channels) && channels.length) return channels;
  const capabilities = await getCampaignCapabilities({ prisma, userId, orgId });
  const ready = (capabilities.channels || []).filter((channel) => channel.executable).map((channel) => channel.id);
  if (!ready.length) {
    const error = new Error('No campaign channel is ready. Connect X, Gmail, or TARA before starting this campaign.');
    error.code = 'campaign_channel_required'; error.status = 409;
    throw error;
  }
  return ready;
}

async function executeCampaignTool(name, args, { prisma, userId, orgId, ctx }) {
  if (!prisma || !userId || !orgId) throw new Error('Campaign tools require an authenticated user and organization');
  if (['campaign_create', 'campaign_regenerate'].includes(name)
      && (String(ctx?.taskTag || ctx?.task_tag || '').toUpperCase() === 'CAMPAIGN' || ctx?.roomKind === 'campaign')) {
    throw new Error('A Campaign Room cannot create or hand off to another Campaign Room');
  }
  if (name === 'campaign_capabilities') return getCampaignCapabilities({ prisma, userId, orgId });
  if (name === 'campaign_list') {
    const campaigns = await listCampaigns({ prisma, orgId });
    return { campaigns: campaigns.map((campaign) => ({ ...compactCampaign(campaign), ...navigation(campaign) })) };
  }
  if (name === 'campaign_get') {
    const campaign = await getCampaign({ prisma, orgId, id: args.campaign_id });
    return { campaign: { ...compactCampaign(campaign), ...navigation(campaign), current_plan_version_id: campaign.currentPlanVersionId || null } };
  }
  if (name === 'campaign_create') {
    const channels = await resolveChannels({ prisma, userId, orgId, channels: args.channels });
    const result = await createCampaign({
      prisma, userId, orgId,
      body: {
        ...args, channels,
        objective: args.objective || 'CUSTOM',
        duration_days: args.duration_days || 14,
        intensity: args.intensity || 'FOCUSED',
        autonomy_mode: args.autonomy_mode || 'APPROVE_PLAN_ONCE',
        idempotency_key: requestKey(args, ctx),
      },
    });
    if (result.created) await auditCampaignTool(prisma, { userId, orgId, campaignId: result.campaign.id, action: 'created', ctx });
    let campaign = result.campaign;
    let dispatchError = null;
    if (result.dispatch) {
      try {
        await dispatchCampaignRoomSafely({ prisma, campaignId: result.campaign.id, dispatch: result.dispatch });
      } catch (error) {
        dispatchError = error;
        campaign = await getCampaign({ prisma, orgId, id: result.campaign.id }).catch(() => result.campaign);
      }
    }
    return {
      tool: 'campaign_create', created: result.created,
      campaign: { ...compactCampaign(campaign), ...navigation(campaign) },
      ...(dispatchError ? {
        warning: `The campaign was created, but its Room could not start: ${dispatchError.message}`,
        retry_in_campaign: true,
      } : {}),
      handoff: dispatchError || ['FAILED', 'NEEDS_INPUT'].includes(campaign.status)
        ? 'The campaign exists but its dedicated Room needs a retry. Nothing has been published.'
        : 'The dedicated Campaign Room is building the operating plan. Nothing has been published.',
    };
  }
  if (name === 'campaign_image_generate') {
    const result = await enqueueCampaignImages({ prisma, orgId, userId, campaignId: args.campaign_id, actionId: args.action_id, creativeBrief: args.creative_brief, variantCount: args.variant_count || 1 });
    await auditCampaignTool(prisma, { userId, orgId, campaignId: args.campaign_id, action: 'asset_generation_queued', ctx });
    return { tool: name, campaign_id: args.campaign_id, action_id: args.action_id, queued: result.queued, assets: result.assets.map((asset) => ({ asset_id: asset.id, status: asset.status })), handoff: 'The campaign visual is being generated for review. Nothing has been published.' };
  }
  if (name === 'campaign_regenerate') {
    const result = await regenerateCampaign({ prisma, orgId, userId, id: args.campaign_id, feedback: args.feedback });
    await dispatchCampaignRoomSafely({ prisma, campaignId: result.campaignId, dispatch: result.dispatch });
    await auditCampaignTool(prisma, { userId, orgId, campaignId: result.campaignId, action: 'regenerated', ctx });
    const campaign = await getCampaign({ prisma, orgId, id: result.campaignId });
    return { tool: name, campaign: { ...compactCampaign(campaign), ...navigation(campaign) }, handoff: 'The Campaign Room is rebuilding the plan. Nothing has been published.' };
  }
  if (name === 'campaign_pause') {
    const campaign = await controlCampaign({ prisma, orgId, userId, id: args.campaign_id, action: 'pause' });
    await auditCampaignTool(prisma, { userId, orgId, campaignId: args.campaign_id, action: 'paused', ctx });
    return { tool: name, campaign: { ...compactCampaign(campaign), ...navigation(campaign) } };
  }
  if (name === 'campaign_sync') {
    const campaign = await syncCampaignMetrics({ prisma, orgId, userId, id: args.campaign_id });
    await auditCampaignTool(prisma, { userId, orgId, campaignId: args.campaign_id, action: 'metrics_synced', ctx });
    return { tool: name, campaign: { ...compactCampaign(campaign), ...navigation(campaign) } };
  }
  throw new Error(`Unknown campaign tool: ${name}`);
}

export function getCampaignToolCatalog() {
  return {
    name: CAMPAIGN_TOOL_GROUP,
    description: 'Create and inspect AI campaigns that run through a dedicated Campaign Room. Planning is automatic; external publishing remains approval-gated in Your Campaigns.',
    tools: toolDefinitions.map(({ name, description, readOnly }) => ({ name, description, readOnly })),
  };
}

export function registerCampaignTools(toolkit, { prisma, userId, orgId, selectedGroups = [] } = {}) {
  if (!selectedGroups.includes(CAMPAIGN_TOOL_GROUP)) return;
  const catalog = getCampaignToolCatalog();
  toolkit.createToolGroup({
    name: catalog.name, description: catalog.description, active: false,
    notes: 'campaign_create starts a dedicated specialist Room and never publishes. campaign_image_generate is only for a ready visual action and queues a reviewable asset. Approval and launch stay in Your Campaigns.',
  });
  for (const definition of toolDefinitions) {
    toolkit.registerToolFunction({
      ...definition,
      groupName: CAMPAIGN_TOOL_GROUP,
      external: false,
      concurrencySafe: definition.readOnly,
      handler: (args, ctx) => executeCampaignTool(definition.name, args, { prisma, userId, orgId, ctx }),
    });
  }
}

export { executeCampaignTool };

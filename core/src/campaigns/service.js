import crypto from 'node:crypto';
import { getCampaignCapabilities } from './capabilities.js';
import { campaignWorkerEnabled, EXECUTABLE_V1_CHANNELS, OBJECTIVES, requireCampaignsV2 } from './state.js';
import { buildCampaignDisplayMessage, buildCampaignRoomDispatch } from './contracts.js';
import { captureCampaignChannelBaseline, reconcileCampaignAction as reconcileWithAdapter, syncCampaignActionMetrics } from './adapters/index.js';

function campaignError(message, status = 400, code = 'invalid_campaign') {
  const error = new Error(message); error.status = status; error.code = code; return error;
}

function cleanText(value, max, label, required = false) {
  const text = String(value || '').trim();
  if (required && !text) throw campaignError(`${label} is required`, 400, `${label.toLowerCase().replaceAll(' ', '_')}_required`);
  if (text.length > max) throw campaignError(`${label} is too long`);
  return text;
}

function cleanStringList(value, maxItems, maxLength, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) throw campaignError(`${label} must be a list`);
  if (value.length > maxItems) throw campaignError(`${label} has too many values`);
  return [...new Set(value.map((item) => cleanText(item, maxLength, label)).filter(Boolean))];
}

function validateDestinationUrl(value) {
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value); } catch { throw campaignError('Destination URL must be a valid URL', 400, 'invalid_destination_url'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw campaignError('Destination URL must use HTTP or HTTPS', 400, 'invalid_destination_url');
  return parsed.toString();
}

export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function canonicalHash(value) {
  return crypto.createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function buildCampaignLaunchSchedule(actions, launchAt = new Date()) {
  const anchor = launchAt instanceof Date ? launchAt : new Date(launchAt);
  if (Number.isNaN(anchor.getTime())) throw campaignError('Campaign launch time is invalid', 400, 'invalid_campaign_launch_time');
  return actions.map((action) => {
    const offsetMinutes = action?.payload?.scheduled_offset_minutes;
    if (!Number.isInteger(offsetMinutes) || offsetMinutes < 0) {
      throw campaignError(`Campaign action ${action?.id || 'unknown'} has an invalid approved schedule`, 409, 'campaign_schedule_invalid');
    }
    return {
      actionId: action.id,
      channel: action.channel,
      offsetMinutes,
      scheduledAt: new Date(anchor.getTime() + offsetMinutes * 60_000),
    };
  });
}

export function validateCampaignBundle(bundle, campaign) {
  const errors = [];
  if (!bundle || typeof bundle !== 'object' || Array.isArray(bundle)) return ['Bundle must be an object'];
  if (!String(bundle.strategy || '').trim()) errors.push('Strategy is required');
  if (!bundle.audience || typeof bundle.audience !== 'object' || !String(bundle.audience.rationale || '').trim()) errors.push('Audience rationale is required');
  if (!Array.isArray(bundle.content_pillars) || !bundle.content_pillars.length) errors.push('Content pillars are required');
  if (!Array.isArray(bundle.kpis) || !bundle.kpis.length) errors.push('KPIs are required');
  const actions = Array.isArray(bundle.actions) ? bundle.actions : [];
  if (!actions.length) errors.push('Actions are required');
  const ids = new Set(); const channels = new Set();
  actions.forEach((action, index) => {
    const id = String(action?.id || '').trim(); const channel = String(action?.channel || '').trim().toLowerCase();
    if (!id || ids.has(id)) errors.push(`Action ${index + 1} needs a unique id`); else ids.add(id);
    if (!campaign.requestedChannels.includes(channel)) errors.push(`Action ${id || index + 1} uses an unrequested channel`); else channels.add(channel);
    if (!String(action?.final_copy || '').trim()) errors.push(`Action ${id || index + 1} needs final copy`);
    if (!String(action?.rationale || '').trim()) errors.push(`Action ${id || index + 1} needs a rationale`);
    if (!action?.payload || typeof action.payload !== 'object' || Array.isArray(action.payload)) errors.push(`Action ${id || index + 1} needs a payload`);
    if (!Number.isInteger(action?.scheduled_offset_minutes) || action.scheduled_offset_minutes < 0) errors.push(`Action ${id || index + 1} has an invalid schedule`);
    if (channel === 'gmail' && !String(action?.payload?.subject || '').trim()) errors.push(`Gmail action ${id || index + 1} needs a subject`);
    if (channel === 'gmail' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(action?.payload?.to || ''))) errors.push(`Gmail action ${id || index + 1} needs a verified recipient`);
    if (channel === 'tara' && !String(action?.payload?.opening || '').trim()) errors.push(`TARA action ${id || index + 1} needs a speak-first opening`);
    if (channel === 'tara' && !/^\+[1-9]\d{6,14}$/.test(String(action?.payload?.to || ''))) errors.push(`TARA action ${id || index + 1} needs a verified E.164 recipient`);
    if (channel === 'tara' && !['legitimate_interest', 'consent'].includes(String(action?.payload?.lawful_basis || ''))) errors.push(`TARA action ${id || index + 1} needs a recognized lawful basis`);
    if (channel === 'tara' && !/^[A-Z]{2}$/.test(String(action?.payload?.country || '').toUpperCase())) errors.push(`TARA action ${id || index + 1} needs an ISO country`);
    if (channel === 'tara') {
      const timezone = String(action?.payload?.timezone || '');
      try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch { errors.push(`TARA action ${id || index + 1} needs a valid IANA timezone`); }
    }
  });
  campaign.requestedChannels.forEach((channel) => { if (!channels.has(channel)) errors.push(`Selected channel ${channel} has no action`); });
  const covered = new Map((Array.isArray(bundle.requirement_coverage) ? bundle.requirement_coverage : []).map((item) => [String(item?.requirement_id || ''), item]));
  for (const requirement of Array.isArray(campaign.requirements) ? campaign.requirements : []) {
    const row = covered.get(String(requirement.id));
    if (!row || !Array.isArray(row.action_ids) || !row.action_ids.length || row.action_ids.some((id) => !ids.has(String(id)))) {
      errors.push(`Requirement ${requirement.id} is not covered by valid actions`);
    }
  }
  return [...new Set(errors)];
}

function renderBundleReport(bundle) {
  const actions = bundle.actions.map((action) => `- **${action.title || action.id}** (${action.channel}): ${action.rationale || ''}`).join('\n');
  const kpis = bundle.kpis.map((kpi) => `- **${kpi.name || 'Metric'}**: ${kpi.target || 'Track from baseline'}`).join('\n');
  const risks = (bundle.risks || []).map((risk) => `- ${risk}`).join('\n') || '- None identified.';
  return `${bundle.strategy}\n\n## Campaign Strategy\n${bundle.strategy}\n\n## Channel Plan\n${actions}\n\n## Audience & Safety\n${bundle.audience.rationale}\n\n## Measurement\n${kpis}\n\n## Gaps to confirm\n${risks}`;
}

function actionType(channel) {
  return { x_organic: 'POST', gmail: 'EMAIL', tara: 'CALL' }[channel] || 'ACTION';
}

function audienceIdentity(action) {
  const value = String(action?.payload?.to || '').trim();
  if (!value) return null;
  if (action.channel === 'gmail') return { dedupeKey: `email:${value.toLowerCase()}`, email: value.toLowerCase(), phone: null };
  if (action.channel === 'tara') return { dedupeKey: `phone:${value.replace(/[\s()/-]/g, '')}`, email: null, phone: value.replace(/[\s()/-]/g, '') };
  return null;
}

export function campaignAgentWhere(orgId) {
  return { orgId, archivedAt: null, status: { not: 'paused' } };
}

export async function persistCampaignBundle({ prisma, turnId, bundle }) {
  const run = await prisma.campaignRun.findUnique({ where: { turnId }, include: { campaign: true } });
  if (!run) return null;
  const errors = validateCampaignBundle(bundle, run.campaign);
  if (errors.length) {
    await markCampaignNeedsInput({ prisma, turnId, errors });
    return { ok: false, errors, campaignId: run.campaignId };
  }
  const bundleHash = canonicalHash(bundle);
  return prisma.$transaction(async (tx) => {
    const claimed = await tx.campaignRun.updateMany({
      where: { id: run.id, status: { in: ['DISPATCHING', 'RUNNING', 'VALIDATING'] } },
      data: { status: 'VALIDATING', validation: { bundle_hash: bundleHash } },
    });
    if (!claimed.count) {
      const existing = await tx.campaignPlanVersion.findFirst({ where: { campaignId: run.campaignId, canonicalHash: bundleHash } });
      return { ok: Boolean(existing), duplicate: true, campaignId: run.campaignId, planVersionId: existing?.id || null };
    }
    const latest = await tx.campaignPlanVersion.findFirst({ where: { campaignId: run.campaignId }, orderBy: { version: 'desc' }, select: { version: true } });
    const version = (latest?.version || 0) + 1;
    const now = Date.now();
    const plan = await tx.campaignPlanVersion.create({ data: {
      campaignId: run.campaignId, version, status: 'READY', canonicalHash: bundleHash,
      bundle, reportMarkdown: renderBundleReport(bundle), validation: { valid: true, errors: [] }, readyAt: new Date(),
    } });
    for (const [position, action] of bundle.actions.entries()) {
      const identity = audienceIdentity(action); let audienceMemberId = null;
      if (identity) {
        const contact = await tx.audienceContact.upsert({
          where: { orgId_dedupeKey: { orgId: run.campaign.orgId, dedupeKey: identity.dedupeKey } },
          create: {
            orgId: run.campaign.orgId, createdBy: run.campaign.ownerUserId, lifecycle: 'PROSPECT',
            displayName: String(action.payload?.recipient_name || '').slice(0, 255) || null,
            company: String(action.payload?.company || '').slice(0, 300) || null,
            email: identity.email, phone: identity.phone, dedupeKey: identity.dedupeKey,
            sourceType: 'campaign_room', sourceRef: run.turnId,
            provenance: { campaign_id: run.campaignId, turn_id: run.turnId, evidence: action.evidence || [] },
            consent: { status: 'unverified', campaign_approval_required: true },
          },
          update: { updatedAt: new Date() },
        });
        const member = await tx.campaignAudienceMember.upsert({
          where: { campaignId_dedupeKey: { campaignId: run.campaignId, dedupeKey: identity.dedupeKey } },
          create: {
            campaignId: run.campaignId, contactId: contact.id, sourceType: 'campaign_room', sourceRef: String(action.id).slice(0, 200),
            dedupeKey: identity.dedupeKey, snapshot: { to: action.payload.to, name: action.payload?.recipient_name || null, company: action.payload?.company || null },
            evidence: { sources: action.evidence || [] },
          },
          update: { contactId: contact.id, snapshot: { to: action.payload.to, name: action.payload?.recipient_name || null, company: action.payload?.company || null }, evidence: { sources: action.evidence || [] } },
        });
        audienceMemberId = member.id;
      }
      await tx.campaignAction.create({ data: {
        campaignId: run.campaignId, planVersionId: plan.id, audienceMemberId, channel: action.channel,
        actionType: actionType(action.channel), position, status: 'READY',
        scheduledAt: new Date(now + action.scheduled_offset_minutes * 60_000),
        payload: { ...action.payload, final_copy: action.final_copy, title: action.title || action.id, evidence: action.evidence || [], source_action_id: String(action.id), scheduled_offset_minutes: action.scheduled_offset_minutes },
        rationale: String(action.rationale || ''), successMetric: String(action.success_metric || '').slice(0, 200) || null,
        idempotencyKey: `plan:${version}:action:${String(action.id).slice(0, 100)}`,
      } });
    }
    await tx.campaign.update({ where: { id: run.campaignId }, data: {
      status: 'READY_FOR_APPROVAL', currentPlanVersionId: plan.id, approvedPlanVersionId: null, lastError: null,
    } });
    await tx.campaignChannel.updateMany({ where: { campaignId: run.campaignId }, data: { status: 'READY' } });
    await tx.campaignRun.update({ where: { id: run.id }, data: {
      status: 'COMPLETED', validation: { valid: true, bundle_hash: bundleHash }, completedAt: new Date(), error: null,
    } });
    await tx.campaignEvent.create({ data: {
      campaignId: run.campaignId, orgId: run.campaign.orgId, eventType: 'campaign_plan_ready',
      data: { plan_version_id: plan.id, version, canonical_hash: bundleHash, action_count: bundle.actions.length },
    } });
    return { ok: true, campaignId: run.campaignId, planVersionId: plan.id, version };
  });
}

export async function markCampaignNeedsInput({ prisma, turnId, errors }) {
  const run = await prisma.campaignRun.findUnique({ where: { turnId }, include: { campaign: { select: { orgId: true } } } });
  if (!run) return null;
  const cleanErrors = (Array.isArray(errors) ? errors : []).map((item) => String(item).slice(0, 500)).slice(0, 30);
  await prisma.$transaction([
    prisma.campaign.update({ where: { id: run.campaignId }, data: { status: 'NEEDS_INPUT', lastError: cleanErrors.join('; ') || 'Campaign bundle validation failed' } }),
    prisma.campaignRun.update({ where: { id: run.id }, data: { status: 'NEEDS_INPUT', validation: { valid: false, errors: cleanErrors }, error: cleanErrors.join('; '), completedAt: new Date() } }),
    prisma.campaignEvent.create({ data: { campaignId: run.campaignId, orgId: run.campaign.orgId, eventType: 'campaign_needs_input', data: { errors: cleanErrors } } }),
  ]);
  return { campaignId: run.campaignId };
}

export function normalizeCampaignInput(body = {}) {
  const goal = cleanText(body.goal, 8000, 'Goal', true);
  const objective = String(body.objective || 'CUSTOM').trim().toUpperCase();
  if (!OBJECTIVES.has(objective)) throw campaignError('Unknown campaign objective', 400, 'invalid_objective');
  const channels = [...new Set((Array.isArray(body.channels) ? body.channels : []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  if (!channels.length) throw campaignError('Select at least one campaign channel', 400, 'channels_required');
  const unsupported = channels.filter((channel) => !EXECUTABLE_V1_CHANNELS.has(channel));
  if (unsupported.length) throw campaignError(`Channels are not executable in V1: ${unsupported.join(', ')}`, 409, 'channel_not_executable');
  const autonomyMode = String(body.autonomy_mode || 'APPROVE_PLAN_ONCE').trim().toUpperCase();
  if (!['APPROVE_PLAN_ONCE', 'REVIEW_EVERY_ACTION'].includes(autonomyMode)) throw campaignError('Unknown approval mode');
  const creationKey = cleanText(body.idempotency_key, 160, 'Idempotency key', true);
  const name = cleanText(body.name, 255, 'Campaign name') || `${objective.replaceAll('_', ' ')} campaign`;
  const durationDays = Number(body.duration_days ?? 14);
  if (!Number.isInteger(durationDays) || durationDays < 1 || durationDays > 365) {
    throw campaignError('Duration must be between 1 and 365 days', 400, 'invalid_duration');
  }
  const timezone = cleanText(body.timezone, 80, 'Timezone') || 'UTC';
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format(); } catch {
    throw campaignError('Timezone is invalid', 400, 'invalid_timezone');
  }
  const requirements = [
    { id: 'goal', text: goal, source: 'user' },
    ...channels.map((channel) => ({ id: `channel:${channel}`, text: `Produce executable ${channel} actions`, source: 'channel' })),
  ];
  return {
    name, goal, objective, channels, autonomyMode, creationKey, requirements,
    brief: {
      offer: cleanText(body.offer, 2000, 'Offer'), cta: cleanText(body.cta, 1000, 'CTA'),
      destination_url: validateDestinationUrl(cleanText(body.destination_url, 2048, 'Destination URL')),
      geography: cleanStringList(body.geography, 100, 160, 'Geography'),
      languages: cleanStringList(body.languages, 50, 80, 'Languages'),
      duration_days: durationDays, cadence: body.cadence && typeof body.cadence === 'object' ? body.cadence : {},
      brand_constraints: cleanText(body.brand_constraints, 4000, 'Brand constraints'),
      prohibited_claims: cleanText(body.prohibited_claims, 4000, 'Prohibited claims'),
      success_metrics: cleanStringList(body.success_metrics, 30, 160, 'Success metrics'),
    },
    audiencePolicy: body.audience || { mode: 'existing_first', discover_if_insufficient: true },
    schedulePolicy: { timezone, start: 'immediate_after_approval' },
  };
}

export async function createCampaign({ prisma, userId, orgId, body }) {
  requireCampaignsV2(orgId);
  const input = normalizeCampaignInput(body);
  const existing = await prisma.campaign.findUnique({
    where: { orgId_ownerUserId_creationKey: { orgId, ownerUserId: userId, creationKey: input.creationKey } },
    include: { runs: { orderBy: { createdAt: 'desc' }, take: 1 }, channels: true },
  }).catch(() => null);
  if (existing) return { campaign: existing, created: false, dispatch: null };

  const capabilities = await getCampaignCapabilities({ prisma, userId, orgId });
  const unavailable = input.channels.filter((id) => !capabilities.channels.find((item) => item.id === id)?.executable);
  if (unavailable.length) throw campaignError(`Connect or configure: ${unavailable.join(', ')}`, 409, 'channel_connection_required');

  const participants = await prisma.digitalEmployee.findMany({
    where: campaignAgentWhere(orgId),
    select: { id: true }, orderBy: { createdAt: 'asc' }, take: 5,
  });
  if (!participants.length) throw campaignError('Complete company onboarding before creating a campaign', 409, 'campaign_team_required');
  const participantIds = participants.map((item) => item.id);

  const campaignId = crypto.randomUUID();
  const roomId = crypto.randomUUID();
  const turnId = crypto.randomUUID();
  const roomGoal = `Campaign ${input.name}\nCompany campaign objective: ${input.goal}`.slice(0, 8000);
  const campaignDraft = {
    id: campaignId, orgId, ownerUserId: userId, name: input.name, goal: input.goal,
    objective: input.objective, requestedChannels: input.channels, brief: input.brief,
    audiencePolicy: input.audiencePolicy,
  };
  const kickoff = buildCampaignDisplayMessage(campaignDraft);
  const briefSnapshot = { ...input, campaign_id: campaignId };
  const [room, campaign, turn, run] = await prisma.$transaction([
    prisma.hyperRoom.create({ data: {
      id: roomId, userId, orgId, name: input.name.slice(0, 120), goal: roomGoal,
      participantIds, template: 'auto', permanentLeadId: participantIds[0],
      enabledConnectors: input.channels.includes('gmail') ? ['gmail'] : [], qualityMode: 'best',
    } }),
    prisma.campaign.create({ data: {
      id: campaignId, orgId, ownerUserId: userId, creationKey: input.creationKey, name: input.name,
      objective: input.objective, goal: input.goal, brief: input.brief, requirements: input.requirements,
      requestedChannels: input.channels, audiencePolicy: input.audiencePolicy,
      schedulePolicy: input.schedulePolicy, autonomyMode: input.autonomyMode,
      roomId, status: 'GENERATING',
    } }),
    prisma.hyperTurn.create({ data: {
      id: turnId, roomId, seq: 1, userMessage: kickoff, status: 'live',
      idempotencyKey: `campaign-kickoff-${campaignId}`, lines: [],
    } }),
    prisma.campaignRun.create({ data: {
      campaignId, roomId, turnId, status: 'DISPATCHING', briefSnapshot, startedAt: new Date(),
    } }),
    prisma.campaignChannel.createMany({
      data: input.channels.map((channel) => ({ campaignId, channel, status: 'PLANNING' })),
    }),
    prisma.campaignEvent.create({ data: {
      campaignId, orgId, eventType: 'campaign_created', actorType: 'user', actorId: userId,
      data: { room_id: roomId, turn_id: turnId, channels: input.channels },
    } }),
  ]);
  const result = { campaign, room, turn, run, kickoff };
  return {
    campaign: { ...result.campaign, channels: input.channels.map((channel) => ({ channel, status: 'PLANNING' })), runs: [result.run] },
    created: true,
    dispatch: buildCampaignRoomDispatch({
      campaign: result.campaign, room: result.room, turn: result.turn, participantIds,
      briefSnapshot,
    }),
  };
}

export async function listCampaigns({ prisma, orgId }) {
  requireCampaignsV2(orgId);
  return prisma.campaign.findMany({
    where: { orgId }, orderBy: { createdAt: 'desc' },
    include: { channels: true, runs: { orderBy: { createdAt: 'desc' }, take: 1 }, approvals: { where: { status: 'ACTIVE' }, orderBy: { approvedAt: 'desc' }, take: 1 }, _count: { select: { actions: true } } },
  });
}

export async function getCampaign({ prisma, orgId, id }) {
  requireCampaignsV2(orgId);
  const campaign = await prisma.campaign.findFirst({
    where: { id, orgId }, include: {
      channels: true, runs: { orderBy: { createdAt: 'desc' } },
      planVersions: { orderBy: { version: 'desc' }, take: 5 },
      actions: { orderBy: { position: 'asc' }, include: { assets: true, audienceMember: true } },
      audience: { orderBy: { createdAt: 'asc' } }, assets: true,
      approvals: { orderBy: { approvedAt: 'desc' }, take: 10 },
      metricSnapshots: { orderBy: { capturedAt: 'desc' }, take: 100 },
      events: { orderBy: { id: 'desc' }, take: 100 },
    },
  });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  const roomTranscript = campaign.roomId ? await prisma.hyperTurn.findMany({
    where: { roomId: campaign.roomId }, orderBy: { seq: 'asc' }, take: 20,
    select: { id: true, seq: true, status: true, lines: true, startedAt: true, sealedAt: true },
  }) : [];
  const currentActions = campaign.currentPlanVersionId
    ? campaign.actions.filter((action) => action.planVersionId === campaign.currentPlanVersionId)
    : [];
  return {
    ...campaign,
    actions: currentActions,
    events: campaign.events.map((event) => ({ ...event, id: String(event.id) })),
    roomTranscript,
  };
}

async function requireCampaignEditor(prisma, campaign, userId) {
  if (campaign.ownerUserId === userId) return;
  const membership = await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId, orgId: campaign.orgId } }, select: { role: true } });
  if (['owner', 'admin'].includes(membership?.role)) return;
  throw campaignError('Only the campaign creator or an organization admin can change this campaign', 403, 'campaign_editor_required');
}

export async function approveCampaign({ prisma, orgId, userId, id, clock = () => new Date() }) {
  requireCampaignsV2(orgId);
  if (!campaignWorkerEnabled()) throw campaignError('Campaign execution is not enabled for this pilot yet', 409, 'campaign_execution_disabled');
  const campaign = await prisma.campaign.findFirst({
    where: { id, orgId }, include: { planVersions: { where: { status: 'READY' }, orderBy: { version: 'desc' }, take: 1 } },
  });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  await requireCampaignEditor(prisma, campaign, userId);
  if (campaign.status !== 'READY_FOR_APPROVAL' || !campaign.currentPlanVersionId || campaign.planVersions[0]?.id !== campaign.currentPlanVersionId) {
    throw campaignError('Campaign does not have a current plan ready for approval', 409, 'campaign_not_ready');
  }
  const plan = campaign.planVersions[0];
  if (canonicalHash(plan.bundle) !== plan.canonicalHash) throw campaignError('Campaign plan integrity check failed', 409, 'campaign_plan_changed');
  const approvedActions = await prisma.campaignAction.findMany({
    where: { campaignId: id, planVersionId: plan.id, status: 'READY' },
    orderBy: [{ position: 'asc' }, { id: 'asc' }],
    select: { id: true, channel: true, payload: true },
  });
  if (!approvedActions.length) throw campaignError('Campaign plan has no actions ready to launch', 409, 'campaign_actions_not_ready');
  const actionHashes = Object.fromEntries(approvedActions.map((action) => [action.id, canonicalHash(action.payload)]));
  const capabilities = await getCampaignCapabilities({ prisma, userId: campaign.ownerUserId, orgId });
  const unavailable = campaign.requestedChannels.filter((channel) => !capabilities.channels.find((item) => item.id === channel)?.execution_ready);
  if (unavailable.length) throw campaignError(`Execution is not ready for: ${unavailable.join(', ')}`, 409, 'channel_execution_unavailable');
  const baselineEntries = await Promise.all(campaign.requestedChannels.map(async (channel) => {
    try { return [channel, await captureCampaignChannelBaseline({ prisma, channel, campaign })]; }
    catch (error) { return [channel, { unavailable: true, reason: String(error?.code || error?.message || 'baseline_unavailable').slice(0, 200) }]; }
  }));
  const launchAtValue = clock();
  const launchAt = launchAtValue instanceof Date ? new Date(launchAtValue.getTime()) : new Date(launchAtValue);
  const launchSchedule = buildCampaignLaunchSchedule(approvedActions, launchAt);
  const baseline = { ...(campaign.baseline || {}), channels: Object.fromEntries(baselineEntries), captured_at: launchAt.toISOString() };
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.campaign.updateMany({
      where: { id, orgId, status: 'READY_FOR_APPROVAL', currentPlanVersionId: plan.id },
      data: { status: 'RUNNING', approvedPlanVersionId: plan.id, startedAt: launchAt, lastError: null, baseline },
    });
    if (!claimed.count) throw campaignError('Campaign approval was already processed', 409, 'campaign_approval_conflict');
    await tx.campaignApproval.updateMany({ where: { campaignId: id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: launchAt } });
    const approval = await tx.campaignApproval.create({ data: {
      campaignId: id, planVersionId: plan.id, actorUserId: userId, canonicalHash: plan.canonicalHash,
      channels: campaign.requestedChannels, recipientCount: Array.isArray(plan.bundle?.actions) ? plan.bundle.actions.filter((item) => item?.payload?.to).length : 0,
      caps: { action_hashes: actionHashes }, autonomyMode: campaign.autonomyMode, approvedAt: launchAt,
    } });
    const actionStatus = campaign.autonomyMode === 'REVIEW_EVERY_ACTION' ? 'AWAITING_APPROVAL' : 'QUEUED';
    for (const scheduled of launchSchedule) {
      const updated = await tx.campaignAction.updateMany({
        where: { id: scheduled.actionId, campaignId: id, planVersionId: plan.id, status: 'READY' },
        data: { status: actionStatus, scheduledAt: scheduled.scheduledAt },
      });
      if (!updated.count) throw campaignError('Campaign actions changed while launch was being approved', 409, 'campaign_action_launch_conflict');
    }
    await tx.campaignAudienceMember.updateMany({ where: { campaignId: id, status: 'PROPOSED' }, data: { status: 'APPROVED', approvedAt: launchAt } });
    await tx.campaignChannel.updateMany({ where: { campaignId: id }, data: { status: 'RUNNING' } });
    await tx.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_approved', actorType: 'user', actorId: userId, data: {
      approval_id: approval.id, plan_version_id: plan.id, canonical_hash: plan.canonicalHash,
      launched_at: launchAt.toISOString(), immediate_action_count: launchSchedule.filter((item) => item.offsetMinutes === 0).length,
      scheduled_action_count: launchSchedule.filter((item) => item.offsetMinutes > 0).length,
    } } });
    return approval;
  });
  return {
    campaignId: id,
    approval: result,
    launch: {
      status: 'RUNNING', launched_at: launchAt.toISOString(), plan_version_id: plan.id,
      channels: campaign.requestedChannels, autonomy_mode: campaign.autonomyMode,
      recipient_count: result.recipientCount,
      action_count: launchSchedule.length,
      immediate_action_count: launchSchedule.filter((item) => item.offsetMinutes === 0).length,
      scheduled_action_count: launchSchedule.filter((item) => item.offsetMinutes > 0).length,
      schedule: launchSchedule.map((item) => ({
        action_id: item.actionId, channel: item.channel, scheduled_at: item.scheduledAt.toISOString(), immediate: item.offsetMinutes === 0,
      })),
    },
  };
}

export async function approveCampaignAction({ prisma, orgId, userId, id, actionId }) {
  requireCampaignsV2(orgId);
  const campaign = await prisma.campaign.findFirst({ where: { id, orgId } });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  await requireCampaignEditor(prisma, campaign, userId);
  if (campaign.autonomyMode !== 'REVIEW_EVERY_ACTION' || !campaign.approvedPlanVersionId || campaign.status !== 'RUNNING') {
    throw campaignError('This campaign is not waiting for individual action approval', 409, 'action_approval_unavailable');
  }
  const updated = await prisma.campaignAction.updateMany({
    where: { id: actionId, campaignId: id, planVersionId: campaign.approvedPlanVersionId, status: 'AWAITING_APPROVAL' },
    data: { status: 'QUEUED' },
  });
  if (!updated.count) throw campaignError('Action is not waiting for approval', 409, 'action_not_awaiting_approval');
  await prisma.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_action_approved', actorType: 'user', actorId: userId, data: { action_id: actionId } } });
  return { campaignId: id, actionId, status: 'QUEUED' };
}

function sourceActionId(action) {
  const stored = String(action?.payload?.source_action_id || '').trim();
  if (stored) return stored;
  const match = String(action?.idempotencyKey || '').match(/:action:(.+)$/);
  return match?.[1] || String(action?.id || '');
}

export function applyCampaignActionEdit(bundle, targetSourceId, patch = {}) {
  const next = structuredClone(bundle || {});
  const actions = Array.isArray(next.actions) ? next.actions : [];
  const index = actions.findIndex((item) => String(item?.id || '') === String(targetSourceId));
  if (index < 0) throw campaignError('The action is not present in the campaign bundle', 409, 'campaign_action_bundle_mismatch');
  if (patch.remove === true) {
    actions.splice(index, 1);
    next.actions = actions;
    next.requirement_coverage = (Array.isArray(next.requirement_coverage) ? next.requirement_coverage : []).map((item) => ({
      ...item,
      action_ids: (Array.isArray(item?.action_ids) ? item.action_ids : []).filter((id) => String(id) !== String(targetSourceId)),
    }));
    return next;
  }
  const current = actions[index];
  const payloadPatch = patch.payload && typeof patch.payload === 'object' && !Array.isArray(patch.payload) ? patch.payload : {};
  const finalCopy = patch.final_copy === undefined ? current.final_copy : cleanText(patch.final_copy, 20000, 'Final copy', true);
  const offset = patch.scheduled_offset_minutes === undefined ? current.scheduled_offset_minutes : Number(patch.scheduled_offset_minutes);
  if (!Number.isInteger(offset) || offset < 0 || offset > 525600) throw campaignError('Schedule offset must be between 0 and 525600 minutes', 400, 'invalid_schedule_offset');
  actions[index] = {
    ...current,
    final_copy: finalCopy,
    payload: { ...(current.payload || {}), ...payloadPatch },
    scheduled_offset_minutes: offset,
    rationale: patch.rationale === undefined ? current.rationale : cleanText(patch.rationale, 8000, 'Rationale', true),
    success_metric: patch.success_metric === undefined ? current.success_metric : cleanText(patch.success_metric, 200, 'Success metric'),
  };
  if (actions[index].channel === 'x_organic') actions[index].payload.text = finalCopy;
  if (actions[index].channel === 'gmail') actions[index].payload.body = finalCopy;
  if (actions[index].channel === 'tara' && payloadPatch.opening === undefined && patch.final_copy !== undefined) actions[index].payload.opening = finalCopy;
  next.actions = actions;
  return next;
}

export async function editCampaignAction({ prisma, orgId, userId, id, actionId, body }) {
  requireCampaignsV2(orgId);
  const campaign = await prisma.campaign.findFirst({
    where: { id, orgId },
    include: {
      planVersions: { where: { status: 'READY' }, orderBy: { version: 'desc' }, take: 1 },
      actions: { where: { id: actionId }, take: 1 },
    },
  });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  await requireCampaignEditor(prisma, campaign, userId);
  if (campaign.status !== 'READY_FOR_APPROVAL' || !campaign.currentPlanVersionId) {
    throw campaignError('Pause or regenerate the campaign before editing its plan', 409, 'campaign_plan_not_editable');
  }
  const plan = campaign.planVersions[0]; const target = campaign.actions[0];
  if (!plan || plan.id !== campaign.currentPlanVersionId || !target || target.planVersionId !== plan.id || target.status !== 'READY') {
    throw campaignError('Only a ready action in the current plan can be edited', 409, 'campaign_action_not_editable');
  }
  if (canonicalHash(plan.bundle) !== plan.canonicalHash) throw campaignError('Campaign plan integrity check failed', 409, 'campaign_plan_changed');
  const removing = body?.remove === true;
  const bundle = applyCampaignActionEdit(plan.bundle, sourceActionId(target), body);
  const errors = validateCampaignBundle(bundle, campaign);
  if (errors.length) throw campaignError(errors.join('; '), 400, 'campaign_action_edit_invalid');
  const hash = canonicalHash(bundle);
  const allActions = await prisma.campaignAction.findMany({ where: { campaignId: id, planVersionId: plan.id }, orderBy: { position: 'asc' } });
  const result = await prisma.$transaction(async (tx) => {
    const latest = await tx.campaignPlanVersion.findFirst({ where: { campaignId: id }, orderBy: { version: 'desc' }, select: { version: true } });
    const version = (latest?.version || plan.version) + 1;
    const nextPlan = await tx.campaignPlanVersion.create({ data: {
      campaignId: id, version, status: 'READY', canonicalHash: hash, bundle,
      reportMarkdown: renderBundleReport(bundle), validation: { valid: true, errors: [], [removing ? 'removed_action_id' : 'edited_action_id']: actionId },
      createdBy: userId, readyAt: new Date(),
    } });
    const bundleActions = new Map(bundle.actions.map((item) => [String(item.id), item]));
    for (const oldAction of allActions) {
      const sourceId = sourceActionId(oldAction); const nextAction = bundleActions.get(sourceId);
      if (!nextAction) continue;
      await tx.campaignAction.create({ data: {
        campaignId: id, planVersionId: nextPlan.id, audienceMemberId: oldAction.audienceMemberId,
        channel: nextAction.channel, actionType: actionType(nextAction.channel), position: oldAction.position, status: 'READY',
        scheduledAt: new Date(Date.now() + nextAction.scheduled_offset_minutes * 60_000), expiresAt: oldAction.expiresAt,
        payload: { ...nextAction.payload, final_copy: nextAction.final_copy, title: nextAction.title || nextAction.id, evidence: nextAction.evidence || [], source_action_id: sourceId, scheduled_offset_minutes: nextAction.scheduled_offset_minutes },
        rationale: String(nextAction.rationale || ''), successMetric: String(nextAction.success_metric || oldAction.successMetric || '').slice(0, 200) || null,
        idempotencyKey: `plan:${version}:action:${sourceId.slice(0, 100)}`,
      } });
    }
    await tx.campaignPlanVersion.update({ where: { id: plan.id }, data: { status: 'SUPERSEDED' } });
    await tx.campaignAction.updateMany({ where: { campaignId: id, planVersionId: plan.id, status: 'READY' }, data: { status: 'CANCELLED' } });
    await tx.campaignApproval.updateMany({ where: { campaignId: id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    await tx.campaign.update({ where: { id }, data: { currentPlanVersionId: nextPlan.id, approvedPlanVersionId: null, status: 'READY_FOR_APPROVAL', lastError: null } });
    await tx.campaignEvent.create({ data: { campaignId: id, orgId, eventType: removing ? 'campaign_action_removed' : 'campaign_action_edited', actorType: 'user', actorId: userId, data: { action_id: actionId, previous_plan_version_id: plan.id, plan_version_id: nextPlan.id, version, canonical_hash: hash } } });
    return { planVersionId: nextPlan.id, version };
  });
  return { campaignId: id, actionId, removed: removing, ...result };
}

export async function regenerateCampaign({ prisma, orgId, userId, id, feedback = '' }) {
  requireCampaignsV2(orgId);
  const campaign = await prisma.campaign.findFirst({ where: { id, orgId } });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  await requireCampaignEditor(prisma, campaign, userId);
  if (!['READY_FOR_APPROVAL', 'NEEDS_INPUT', 'FAILED'].includes(campaign.status) || !campaign.roomId) {
    throw campaignError('This campaign cannot be regenerated in its current state', 409, 'campaign_regeneration_unavailable');
  }
  const room = await prisma.hyperRoom.findUnique({ where: { id: campaign.roomId } });
  if (!room) throw campaignError('Campaign Room not found', 409, 'campaign_room_missing');
  const participantIds = Array.isArray(room.participantIds) ? room.participantIds : [];
  if (!participantIds.length) throw campaignError('Campaign Room has no active agents', 409, 'campaign_team_required');
  const cleanFeedback = cleanText(feedback, 4000, 'Regeneration feedback');
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.campaign.updateMany({
      where: { id, orgId, status: { in: ['READY_FOR_APPROVAL', 'NEEDS_INPUT', 'FAILED'] } },
      data: { status: 'GENERATING', currentPlanVersionId: null, approvedPlanVersionId: null, lastError: null },
    });
    if (!claimed.count) throw campaignError('Campaign regeneration was already started', 409, 'campaign_regeneration_conflict');
    const lastTurn = await tx.hyperTurn.findFirst({ where: { roomId: room.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
    const kickoff = buildCampaignDisplayMessage(campaign, cleanFeedback);
    const turn = await tx.hyperTurn.create({ data: {
      roomId: room.id, seq: (lastTurn?.seq || 0) + 1, userMessage: kickoff, status: 'live',
      idempotencyKey: `campaign-regen-${crypto.randomUUID()}`, lines: [],
    } });
    const briefSnapshot = {
      name: campaign.name, goal: campaign.goal, objective: campaign.objective, channels: campaign.requestedChannels,
      autonomyMode: campaign.autonomyMode, requirements: campaign.requirements, brief: campaign.brief,
      audiencePolicy: campaign.audiencePolicy, schedulePolicy: campaign.schedulePolicy, campaign_id: id,
      feedback: cleanFeedback || undefined,
    };
    const run = await tx.campaignRun.create({ data: { campaignId: id, roomId: room.id, turnId: turn.id, status: 'DISPATCHING', briefSnapshot, startedAt: new Date() } });
    if (campaign.currentPlanVersionId) {
      await tx.campaignPlanVersion.updateMany({ where: { id: campaign.currentPlanVersionId, campaignId: id }, data: { status: 'SUPERSEDED' } });
      await tx.campaignAction.updateMany({ where: { campaignId: id, planVersionId: campaign.currentPlanVersionId, status: 'READY' }, data: { status: 'CANCELLED' } });
    }
    await tx.campaignApproval.updateMany({ where: { campaignId: id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    await tx.campaignChannel.updateMany({ where: { campaignId: id }, data: { status: 'PLANNING', lastError: null } });
    await tx.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_regeneration_started', actorType: 'user', actorId: userId, data: { turn_id: turn.id, feedback: cleanFeedback || null } } });
    return { turn, run, briefSnapshot };
  });
  return {
    campaignId: id,
    dispatch: buildCampaignRoomDispatch({ campaign, room, turn: result.turn, participantIds, briefSnapshot: result.briefSnapshot }),
  };
}

async function getActionForControl(prisma, { orgId, userId, id, actionId }) {
  const campaign = await prisma.campaign.findFirst({ where: { id, orgId } });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  await requireCampaignEditor(prisma, campaign, userId);
  const action = await prisma.campaignAction.findFirst({
    where: { id: actionId, campaignId: id }, include: { campaign: true, attempts: { orderBy: { attempt: 'desc' }, take: 5 } },
  });
  if (!action) throw campaignError('Campaign action not found', 404, 'campaign_action_not_found');
  return { campaign, action };
}

export async function retryCampaignAction({ prisma, orgId, userId, id, actionId }) {
  requireCampaignsV2(orgId);
  if (!campaignWorkerEnabled()) throw campaignError('Campaign execution is not enabled for this pilot yet', 409, 'campaign_execution_disabled');
  const { campaign, action } = await getActionForControl(prisma, { orgId, userId, id, actionId });
  if (!['FAILED', 'BLOCKED'].includes(action.status)) {
    throw campaignError('Only definitively failed or blocked actions can be retried', 409, 'campaign_action_not_retryable');
  }
  if (!campaign.approvedPlanVersionId || action.planVersionId !== campaign.approvedPlanVersionId) {
    throw campaignError('The action is not part of the approved plan', 409, 'campaign_action_not_approved');
  }
  const capabilities = await getCampaignCapabilities({ prisma, userId: campaign.ownerUserId, orgId });
  if (!capabilities.channels.find((item) => item.id === action.channel)?.execution_ready) {
    throw campaignError(`Execution is not ready for ${action.channel}`, 409, 'channel_execution_unavailable');
  }
  await prisma.$transaction([
    prisma.campaignAction.update({ where: { id: action.id }, data: { status: 'QUEUED', lastError: null, leaseOwner: null, leaseExpiresAt: null } }),
    prisma.campaign.update({ where: { id }, data: { status: 'RUNNING', completedAt: null, lastError: null } }),
    prisma.campaignChannel.update({ where: { campaignId_channel: { campaignId: id, channel: action.channel } }, data: { status: 'RUNNING', lastError: null } }),
    prisma.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_action_retry_requested', actorType: 'user', actorId: userId, data: { action_id: action.id } } }),
  ]);
  return { campaignId: id, actionId: action.id, status: 'QUEUED' };
}

export async function reconcileCampaignAction({ prisma, orgId, userId, id, actionId }) {
  requireCampaignsV2(orgId);
  const { action } = await getActionForControl(prisma, { orgId, userId, id, actionId });
  if (action.status !== 'NEEDS_RECONCILIATION') {
    throw campaignError('Only ambiguous actions can be reconciled', 409, 'campaign_action_reconciliation_unavailable');
  }
  const result = await reconcileWithAdapter({ prisma, action });
  if (result.status === 'SUCCEEDED') {
    await prisma.$transaction([
      prisma.campaignAction.update({ where: { id: action.id }, data: { status: 'SUCCEEDED', externalId: result.externalId || null, executedAt: new Date(), lastError: null } }),
      prisma.campaignActionAttempt.updateMany({ where: { actionId: action.id, status: 'NEEDS_RECONCILIATION' }, data: { status: 'SUCCEEDED', externalId: result.externalId || null, response: result.response || {}, completedAt: new Date() } }),
      prisma.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_action_reconciled', actorType: 'user', actorId: userId, data: { action_id: action.id, status: 'SUCCEEDED', external_id: result.externalId || null } } }),
    ]);
    await finishCampaignAfterActionControl(prisma, id);
  } else {
    await prisma.$transaction([
      prisma.campaignAction.update({ where: { id: action.id }, data: { lastError: result.reason || 'Manual provider inspection is required' } }),
      prisma.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_action_reconciliation_pending', actorType: 'user', actorId: userId, data: { action_id: action.id, reason: result.reason } } }),
    ]);
  }
  return { campaignId: id, actionId: action.id, ...result };
}

function sumMetricRows(rows) {
  const totals = {};
  for (const row of rows) {
    for (const [key, value] of Object.entries(row || {})) {
      if (typeof value === 'number' && Number.isFinite(value)) totals[key] = (totals[key] || 0) + value;
    }
  }
  return totals;
}

export async function syncCampaignMetrics({ prisma, orgId, userId, id }) {
  requireCampaignsV2(orgId);
  const campaign = await prisma.campaign.findFirst({
    where: { id, orgId }, include: { actions: { where: { status: 'SUCCEEDED' }, orderBy: { position: 'asc' } } },
  });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  await requireCampaignEditor(prisma, campaign, userId);
  const actions = campaign.currentPlanVersionId ? campaign.actions.filter((action) => action.planVersionId === campaign.currentPlanVersionId) : [];
  const byChannel = new Map(); const errors = [];
  for (const row of actions) {
    const action = { ...row, campaign };
    try {
      const metrics = await syncCampaignActionMetrics({ prisma, action });
      await prisma.campaignMetricSnapshot.create({ data: { campaignId: id, channel: action.channel, actionId: action.id, period: 'TOTAL', metrics } });
      if (!byChannel.has(action.channel)) byChannel.set(action.channel, []);
      byChannel.get(action.channel).push(metrics);
    } catch (error) {
      errors.push({ action_id: action.id, channel: action.channel, code: String(error?.code || 'metric_sync_failed'), message: String(error?.message || error).slice(0, 300) });
    }
  }
  for (const [channel, rows] of byChannel) {
    const totals = sumMetricRows(rows);
    const baseline = campaign.baseline?.channels?.[channel] || {};
    if (channel === 'x_organic') totals.followers = Number(rows.at(-1)?.followers || 0);
    if (channel === 'x_organic' && typeof totals.followers === 'number' && typeof baseline.followers === 'number') totals.follower_delta = totals.followers - baseline.followers;
    if (channel === 'x_organic' && totals.impressions > 0) totals.engagement_rate = (totals.engagements || 0) / totals.impressions;
    await prisma.campaignChannel.update({ where: { campaignId_channel: { campaignId: id, channel } }, data: { metrics: { ...totals, synced_at: new Date().toISOString() }, lastError: null } });
  }
  await prisma.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_metrics_synced', actorType: 'user', actorId: userId, data: { action_count: actions.length, channels: [...byChannel.keys()], errors } } });
  return getCampaign({ prisma, orgId, id });
}

async function finishCampaignAfterActionControl(prisma, campaignId) {
  const remaining = await prisma.campaignAction.count({ where: { campaignId, status: { notIn: ['SUCCEEDED', 'FAILED', 'BLOCKED', 'NEEDS_RECONCILIATION', 'CANCELLED'] } } });
  if (remaining) return;
  const failed = await prisma.campaignAction.count({ where: { campaignId, status: { in: ['FAILED', 'BLOCKED', 'NEEDS_RECONCILIATION'] } } });
  await prisma.campaign.update({ where: { id: campaignId }, data: { status: failed ? 'FAILED' : 'COMPLETED', completedAt: new Date() } });
}

export async function controlCampaign({ prisma, orgId, userId, id, action }) {
  requireCampaignsV2(orgId);
  const campaign = await prisma.campaign.findFirst({ where: { id, orgId } });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  await requireCampaignEditor(prisma, campaign, userId);
  if (action === 'pause') {
    if (!['RUNNING', 'SCHEDULED'].includes(campaign.status)) throw campaignError('Only a running campaign can be paused', 409, 'campaign_not_running');
    await prisma.$transaction([
      prisma.campaign.update({ where: { id }, data: { status: 'PAUSED', pausedAt: new Date() } }),
      prisma.campaignAction.updateMany({ where: { campaignId: id, status: 'QUEUED' }, data: { status: 'PAUSED' } }),
      prisma.campaignChannel.updateMany({ where: { campaignId: id }, data: { status: 'PAUSED' } }),
      prisma.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_paused', actorType: 'user', actorId: userId } }),
    ]);
  } else if (action === 'resume') {
    if (!campaignWorkerEnabled()) throw campaignError('Campaign execution is not enabled for this pilot yet', 409, 'campaign_execution_disabled');
    if (campaign.status !== 'PAUSED') throw campaignError('Only a paused campaign can be resumed', 409, 'campaign_not_paused');
    const capabilities = await getCampaignCapabilities({ prisma, userId: campaign.ownerUserId, orgId });
    const unavailable = campaign.requestedChannels.filter((channel) => !capabilities.channels.find((item) => item.id === channel)?.execution_ready);
    if (unavailable.length) throw campaignError(`Execution is not ready for: ${unavailable.join(', ')}`, 409, 'channel_execution_unavailable');
    await prisma.$transaction([
      prisma.campaign.update({ where: { id }, data: { status: 'RUNNING', pausedAt: null, lastError: null } }),
      prisma.campaignAction.updateMany({ where: { campaignId: id, status: 'PAUSED' }, data: { status: 'QUEUED' } }),
      prisma.campaignChannel.updateMany({ where: { campaignId: id }, data: { status: 'RUNNING' } }),
      prisma.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_resumed', actorType: 'user', actorId: userId } }),
    ]);
  } else {
    throw campaignError('Unknown campaign control action', 404, 'unknown_campaign_action');
  }
  return getCampaign({ prisma, orgId, id });
}

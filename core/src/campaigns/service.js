import crypto from 'node:crypto';
import { getCampaignCapabilities } from './capabilities.js';
import { EXECUTABLE_V1_CHANNELS, OBJECTIVES, requireCampaignsV2 } from './state.js';

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
        payload: { ...action.payload, final_copy: action.final_copy, title: action.title || action.id, evidence: action.evidence || [] },
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

function kickoffFor(campaign) {
  return [
    `CAMPAIGN_ID: ${campaign.id}`,
    `GOAL: ${campaign.goal}`,
    `OBJECTIVE: ${campaign.objective}`,
    `CHANNELS: ${campaign.requestedChannels.join(', ')}`,
    `BRIEF_JSON: ${JSON.stringify(campaign.brief)}`,
    `AUDIENCE_POLICY_JSON: ${JSON.stringify(campaign.audiencePolicy)}`,
    'Execute the Campaign Room workflow now: gather company and existing-audience evidence first, debate the strategy, create final ready-to-send channel actions, and submit the complete plan with campaign__submit_plan. Do not send any external action.',
  ].join('\n');
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
    where: { orgId, archivedAt: null, status: { in: ['running', 'active'] } },
    select: { id: true }, orderBy: { createdAt: 'asc' }, take: 5,
  });
  if (!participants.length) throw campaignError('Complete company onboarding before creating a campaign', 409, 'campaign_team_required');
  const participantIds = participants.map((item) => item.id);

  const result = await prisma.$transaction(async (tx) => {
    const campaign = await tx.campaign.create({ data: {
      orgId, ownerUserId: userId, creationKey: input.creationKey, name: input.name,
      objective: input.objective, goal: input.goal, brief: input.brief, requirements: input.requirements,
      requestedChannels: input.channels, audiencePolicy: input.audiencePolicy,
      schedulePolicy: input.schedulePolicy, autonomyMode: input.autonomyMode, status: 'DRAFT',
    } });
    const roomGoal = `Campaign ${campaign.name}\nCompany campaign objective: ${campaign.goal}\nCampaign ID: ${campaign.id}`.slice(0, 8000);
    const room = await tx.hyperRoom.create({ data: {
      userId, orgId, name: campaign.name.slice(0, 120), goal: roomGoal,
      participantIds, template: 'auto', permanentLeadId: participantIds[0],
      enabledConnectors: input.channels.includes('gmail') ? ['gmail'] : [], qualityMode: 'best',
    } });
    const withRoom = await tx.campaign.update({ where: { id: campaign.id }, data: { roomId: room.id, status: 'GENERATING' } });
    const kickoff = kickoffFor(withRoom);
    const turn = await tx.hyperTurn.create({ data: {
      roomId: room.id, seq: 1, userMessage: kickoff, status: 'live',
      idempotencyKey: `campaign-kickoff-${campaign.id}`, lines: [],
    } });
    const run = await tx.campaignRun.create({ data: {
      campaignId: campaign.id, roomId: room.id, turnId: turn.id, status: 'DISPATCHING',
      briefSnapshot: { ...input, campaign_id: campaign.id }, startedAt: new Date(),
    } });
    await tx.campaignChannel.createMany({ data: input.channels.map((channel) => ({ campaignId: campaign.id, channel, status: 'PLANNING' })) });
    await tx.campaignEvent.create({ data: { campaignId: campaign.id, orgId, eventType: 'campaign_created', actorType: 'user', actorId: userId, data: { room_id: room.id, turn_id: turn.id, channels: input.channels } } });
    return { campaign: withRoom, room, turn, run, kickoff };
  });
  return {
    campaign: { ...result.campaign, channels: input.channels.map((channel) => ({ channel, status: 'PLANNING' })), runs: [result.run] },
    created: true,
    dispatch: {
      room_id: result.room.id, turn_id: result.turn.id, user_id: userId, org_id: orgId,
      user_message: result.kickoff, participant_ids: participantIds, room_goal: result.room.goal,
      task_tag: 'CAMPAIGN', campaign_id: result.campaign.id,
      campaign_brief: { ...input, campaign_id: result.campaign.id }, write_policy: 'ask',
      callback_url: `${process.env.CONTROL_PLANE_INTERNAL_URL || 'http://hm-control:3000'}/internal/hyper/turn-event`,
    },
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
    },
  });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  const roomTranscript = campaign.roomId ? await prisma.hyperTurn.findMany({
    where: { roomId: campaign.roomId }, orderBy: { seq: 'asc' }, take: 20,
    select: { id: true, seq: true, userMessage: true, status: true, lines: true, startedAt: true, sealedAt: true },
  }) : [];
  return { ...campaign, roomTranscript };
}

async function requireCampaignEditor(prisma, campaign, userId) {
  if (campaign.ownerUserId === userId) return;
  const membership = await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId, orgId: campaign.orgId } }, select: { role: true } });
  if (['owner', 'admin'].includes(membership?.role)) return;
  throw campaignError('Only the campaign creator or an organization admin can change this campaign', 403, 'campaign_editor_required');
}

export async function approveCampaign({ prisma, orgId, userId, id }) {
  requireCampaignsV2(orgId);
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
  const capabilities = await getCampaignCapabilities({ prisma, userId: campaign.ownerUserId, orgId });
  const unavailable = campaign.requestedChannels.filter((channel) => !capabilities.channels.find((item) => item.id === channel)?.executable);
  if (unavailable.length) throw campaignError(`Reconnect or configure before approval: ${unavailable.join(', ')}`, 409, 'channel_connection_required');
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.campaign.updateMany({
      where: { id, orgId, status: 'READY_FOR_APPROVAL', currentPlanVersionId: plan.id },
      data: { status: 'RUNNING', approvedPlanVersionId: plan.id, startedAt: new Date(), lastError: null },
    });
    if (!claimed.count) throw campaignError('Campaign approval was already processed', 409, 'campaign_approval_conflict');
    await tx.campaignApproval.updateMany({ where: { campaignId: id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: new Date() } });
    const approval = await tx.campaignApproval.create({ data: {
      campaignId: id, planVersionId: plan.id, actorUserId: userId, canonicalHash: plan.canonicalHash,
      channels: campaign.requestedChannels, recipientCount: Array.isArray(plan.bundle?.actions) ? plan.bundle.actions.filter((item) => item?.payload?.to).length : 0,
      caps: {}, autonomyMode: campaign.autonomyMode,
    } });
    await tx.campaignAction.updateMany({
      where: { campaignId: id, planVersionId: plan.id, status: 'READY' },
      data: { status: campaign.autonomyMode === 'REVIEW_EVERY_ACTION' ? 'AWAITING_APPROVAL' : 'QUEUED' },
    });
    await tx.campaignAudienceMember.updateMany({ where: { campaignId: id, status: 'PROPOSED' }, data: { status: 'APPROVED', approvedAt: new Date() } });
    await tx.campaignChannel.updateMany({ where: { campaignId: id }, data: { status: 'RUNNING' } });
    await tx.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_approved', actorType: 'user', actorId: userId, data: { approval_id: approval.id, plan_version_id: plan.id, canonical_hash: plan.canonicalHash } } });
    return approval;
  });
  return { campaignId: id, approval: result };
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
    if (campaign.status !== 'PAUSED') throw campaignError('Only a paused campaign can be resumed', 409, 'campaign_not_paused');
    const capabilities = await getCampaignCapabilities({ prisma, userId: campaign.ownerUserId, orgId });
    const unavailable = campaign.requestedChannels.filter((channel) => !capabilities.channels.find((item) => item.id === channel)?.executable);
    if (unavailable.length) throw campaignError(`Reconnect or configure before resuming: ${unavailable.join(', ')}`, 409, 'channel_connection_required');
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

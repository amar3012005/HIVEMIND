import crypto from 'node:crypto';
import { campaignCapabilitySnapshot, getCampaignCapabilities } from './capabilities.js';
import { campaignWorkerEnabled, KNOWN_CHANNELS, OBJECTIVES, requireCampaignPlanning, requireCampaignsV2 } from './state.js';
import { buildCampaignDisplayMessage, buildCampaignRoomDispatch } from './contracts.js';
import { captureCampaignChannelBaseline, pauseCampaignAction, reconcileCampaignAction as reconcileWithAdapter, resumeCampaignAction, syncCampaignActionMetrics } from './adapters/index.js';
import { DEFAULT_CAMPAIGN_IMAGE_MODEL } from './image-provider.js';
import { buildCampaignImagePrompt, creativeBriefErrors, normalizeCreativeBrief } from './visual-prompt.js';
import { campaignError } from './errors.js';
import { assessCampaignReadiness } from './readiness.js';

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

const HIGH_RISK_CLAIM_TERMS = ['only', 'never', 'always', 'guarantee', 'guaranteed', 'ensures', 'ensuring', 'certified', 'compliant'];

function unsupportedEvidenceMarkers(copy, evidenceClaims = []) {
  const publicCopy = String(copy || '').toLowerCase();
  const support = evidenceClaims.map((claim) => String(claim || '').toLowerCase()).join(' ');
  const numeric = publicCopy.match(/\b\d+(?:[.,]\d+)?\s*(?:%|ms|x|k|m|b)?\b/g) || [];
  const markers = numeric.filter((value) => !support.includes(value));
  for (const term of HIGH_RISK_CLAIM_TERMS) {
    const pattern = new RegExp(`\\b${term}\\b`, 'i');
    if (pattern.test(publicCopy) && !pattern.test(support)) markers.push(term);
  }
  return [...new Set(markers)].sort();
}

function validateDestinationUrl(value) {
  if (!value) return '';
  let parsed;
  try { parsed = new URL(value); } catch { throw campaignError('Destination URL must be a valid URL', 400, 'invalid_destination_url'); }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw campaignError('Destination URL must use HTTP or HTTPS', 400, 'invalid_destination_url');
  return parsed.toString();
}

const CAMPAIGN_INTENSITIES = new Set(['LIGHT', 'FOCUSED', 'HIGH']);
const CONTENT_ACTION_RANGES = {
  LIGHT: [[3, 4], [4, 6], [8, 12]],
  FOCUSED: [[4, 6], [6, 8], [12, 16]],
  HIGH: [[6, 8], [9, 12], [18, 24]],
};
const DIRECT_ACTION_RANGES = {
  LIGHT: [[1, 2], [2, 3], [3, 5]],
  FOCUSED: [[2, 3], [3, 5], [5, 8]],
  HIGH: [[3, 5], [5, 8], [8, 12]],
};
const ORGANIC_SOCIAL_CHANNELS = new Set([
  'x_organic', 'linkedin', 'instagram', 'facebook', 'tiktok', 'youtube',
  'pinterest', 'reddit', 'threads', 'bluesky', 'google_business',
]);

export function campaignActionRanges({ durationDays = 14, intensity = 'FOCUSED', channels = [] } = {}) {
  const normalizedIntensity = String(intensity || 'FOCUSED').trim().toUpperCase();
  if (!CAMPAIGN_INTENSITIES.has(normalizedIntensity)) throw campaignError('Unknown campaign intensity', 400, 'invalid_campaign_intensity');
  const horizonIndex = Number(durationDays) <= 7 ? 0 : Number(durationDays) <= 14 ? 1 : 2;
  const expected = {};
  for (const channel of channels) {
    const range = ORGANIC_SOCIAL_CHANNELS.has(channel)
      ? CONTENT_ACTION_RANGES[normalizedIntensity][horizonIndex]
      : DIRECT_ACTION_RANGES[normalizedIntensity][horizonIndex];
    expected[channel] = { minimum: range[0], maximum: range[1] };
  }
  return {
    preset: normalizedIntensity.toLowerCase(),
    duration_days: Number(durationDays),
    expected_actions_by_channel: expected,
    total_minimum: Object.values(expected).reduce((total, range) => total + range.minimum, 0),
    total_maximum: Object.values(expected).reduce((total, range) => total + range.maximum, 0),
  };
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
    if (channel === 'x_organic') {
      const postText = String(action?.payload?.text || '').trim();
      const finalCopy = String(action?.final_copy || '').trim();
      if (!postText) errors.push(`X action ${id || index + 1} needs payload.text`);
      else if (Array.from(postText).length > 280) errors.push(`X action ${id || index + 1} payload.text must be 280 characters or fewer; split threads into separate actions`);
      if (postText && finalCopy && postText !== finalCopy) errors.push(`X action ${id || index + 1} payload.text must match final copy`);
    }
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
  const storedCadence = campaign?.brief?.cadence && typeof campaign.brief.cadence === 'object' ? campaign.brief.cadence : {};
  const effectiveCadence = Object.keys(storedCadence.expected_actions_by_channel || {}).length
    ? storedCadence
    : Number(bundle.contract_version || 1) >= 3 ? campaignActionRanges({
      durationDays: campaign?.brief?.duration_days || 14,
      intensity: storedCadence.preset || 'FOCUSED',
      channels: campaign?.requestedChannels || [],
    }) : {};
  const expectedByChannel = effectiveCadence.expected_actions_by_channel || {};
  for (const channel of campaign.requestedChannels || []) {
    const expected = expectedByChannel[channel];
    if (!expected) continue;
    const count = actions.filter((action) => String(action?.channel || '').toLowerCase() === channel).length;
    if (count < Number(expected.minimum || 0) || count > Number(expected.maximum || Number.MAX_SAFE_INTEGER)) {
      errors.push(`Channel ${channel} needs ${expected.minimum}-${expected.maximum} actions for this campaign pace; received ${count}`);
    }
  }
  const covered = new Map((Array.isArray(bundle.requirement_coverage) ? bundle.requirement_coverage : []).map((item) => [String(item?.requirement_id || ''), item]));
  for (const requirement of Array.isArray(campaign.requirements) ? campaign.requirements : []) {
    const row = covered.get(String(requirement.id));
    if (!row || !Array.isArray(row.action_ids) || !row.action_ids.length || row.action_ids.some((id) => !ids.has(String(id)))) {
      errors.push(`Requirement ${requirement.id} is not covered by valid actions`);
    }
  }
  if (Number(bundle.contract_version || 1) >= 3) {
    const options = Array.isArray(bundle.strategy_options) ? bundle.strategy_options : [];
    if (options.length < 3) errors.push('Contract v3 needs at least three strategy options');
    const optionIds = new Set(options.map((option) => String(option?.id || '')).filter(Boolean));
    if (!optionIds.has(String(bundle.selected_strategy_id || ''))) errors.push('Contract v3 selected_strategy_id must reference a strategy option');
    if (!bundle.company_grounding || typeof bundle.company_grounding !== 'object' || !String(bundle.company_grounding.company_name || '').trim()) errors.push('Contract v3 needs company grounding');
    if (!Array.isArray(bundle.evidence) || !bundle.evidence.length) errors.push('Contract v3 evidence must not be empty');
    const horizon = bundle.campaign_horizon;
    if (!horizon || Number(horizon.duration_days) !== Number(campaign?.brief?.duration_days || 14)) errors.push('Contract v3 campaign horizon must match the approved brief');
    if (!horizon || String(horizon.intensity || '').toLowerCase() !== String(campaign?.brief?.cadence?.preset || 'focused').toLowerCase()) errors.push('Contract v3 campaign intensity must match the approved brief');
    actions.forEach((action, index) => {
      if (!action?.creative_brief || typeof action.creative_brief !== 'object') errors.push(`Action ${action?.id || index + 1} needs a creative brief`);
      creativeBriefErrors(action?.creative_brief).forEach((error) => errors.push(`Action ${action?.id || index + 1}: ${error}`));
      if (!['verified', 'assumption', 'no_claim'].includes(String(action?.claim_status || ''))) errors.push(`Action ${action?.id || index + 1} needs a valid claim status`);
      else if (action?.claim_status === 'assumption') errors.push(`Action ${action?.id || index + 1} cannot publish an assumption as final copy`);
      if (action?.claim_status === 'verified' && (!Array.isArray(action?.evidence_ids) || !action.evidence_ids.length)) errors.push(`Action ${action?.id || index + 1} needs evidence for a verified claim`);
    });
    const quality = bundle.quality_gate;
    const requiredChecks = ['goal_alignment', 'company_grounding', 'channel_completeness', 'provider_validity', 'schedule_completeness'];
    if (!quality || quality.ready !== true) errors.push('Contract v3 quality gate must be ready');
    requiredChecks.forEach((check) => { if (quality?.checks?.[check] !== 'passed') errors.push(`Contract v3 quality check ${check} must pass`); });
  }
  if (Number(bundle.contract_version || 1) >= 4) {
    const evidenceRows = Array.isArray(bundle.evidence) ? bundle.evidence : [];
    const evidenceIds = new Set(evidenceRows.map((item) => String(item?.id || '')).filter(Boolean));
    const evidenceStatuses = new Map(evidenceRows.map((item) => [String(item?.id || ''), String(item?.status || '')]));
    const evidenceClaims = new Map(evidenceRows.map((item) => [String(item?.id || ''), String(item?.claim || '')]));
    bundle.kpis.forEach((kpi, index) => {
      const targetType = String(kpi?.target_type || '');
      if (!['baseline', 'proposed', 'verified'].includes(targetType)) errors.push(`Contract v4 KPI ${index + 1} needs a valid target type`);
      if (!Array.isArray(kpi?.evidence_ids)) errors.push(`Contract v4 KPI ${index + 1} evidence ids must be an array`);
      else if (kpi.evidence_ids.some((id) => !evidenceIds.has(String(id)))) errors.push(`Contract v4 KPI ${index + 1} references unknown evidence`);
      else if (targetType === 'verified' && (!kpi.evidence_ids.length || kpi.evidence_ids.some((id) => evidenceStatuses.get(String(id)) !== 'verified'))) errors.push(`Contract v4 KPI ${index + 1} verified target must reference verified evidence`);
    });

    const mediaPlan = bundle.media_plan;
    const mediaChannels = Array.isArray(mediaPlan?.channels) ? mediaPlan.channels : [];
    if (!mediaPlan || typeof mediaPlan !== 'object' || Array.isArray(mediaPlan)) errors.push('Contract v4 needs a media plan');
    if (!mediaChannels.length) errors.push('Contract v4 media plan needs channels');
    const plannedChannels = new Set();
    mediaChannels.forEach((row, index) => {
      const channel = String(row?.channel || '').trim().toLowerCase();
      if (!channel || plannedChannels.has(channel)) errors.push(`Contract v4 media channel ${index + 1} needs a unique channel`);
      else if (!campaign.requestedChannels.includes(channel)) errors.push(`Contract v4 media channel ${channel} was not selected`);
      else plannedChannels.add(channel);
      if (!String(row?.role || '').trim()) errors.push(`Contract v4 media channel ${channel || index + 1} needs a role`);
      if (!String(row?.rationale || '').trim()) errors.push(`Contract v4 media channel ${channel || index + 1} needs a rationale`);
      if (row?.budget_amount != null && (typeof row.budget_amount !== 'number' || !Number.isFinite(row.budget_amount) || row.budget_amount < 0)) errors.push(`Contract v4 media channel ${channel || index + 1} has an invalid budget`);
      if (!Array.isArray(row?.prerequisites)) errors.push(`Contract v4 media channel ${channel || index + 1} prerequisites must be an array`);
      if (!Array.isArray(row?.exclusions)) errors.push(`Contract v4 media channel ${channel || index + 1} exclusions must be an array`);
    });
    campaign.requestedChannels.forEach((channel) => { if (!plannedChannels.has(channel)) errors.push(`Contract v4 media plan is missing ${channel}`); });
    if (mediaPlan?.currency != null && !/^[A-Z]{3}$/.test(String(mediaPlan.currency))) errors.push('Contract v4 media currency must be a three-letter code or null');

    const creativeSystem = bundle.creative_system;
    const hypotheses = Array.isArray(creativeSystem?.hypotheses) ? creativeSystem.hypotheses : [];
    if (!creativeSystem || typeof creativeSystem !== 'object' || Array.isArray(creativeSystem)) errors.push('Contract v4 needs a creative system');
    if (hypotheses.length < 2) errors.push('Contract v4 needs at least two creative hypotheses');
    const hypothesisIds = new Set();
    hypotheses.forEach((hypothesis, index) => {
      const id = String(hypothesis?.id || '').trim();
      if (!id || hypothesisIds.has(id)) errors.push(`Contract v4 creative hypothesis ${index + 1} needs a unique id`); else hypothesisIds.add(id);
      for (const field of ['insight', 'promise', 'hook', 'cta', 'experiment_hypothesis']) {
        if (!String(hypothesis?.[field] || '').trim()) errors.push(`Contract v4 creative hypothesis ${id || index + 1} needs ${field}`);
      }
      if (!Array.isArray(hypothesis?.channels) || !hypothesis.channels.length) errors.push(`Contract v4 creative hypothesis ${id || index + 1} needs channels`);
      else if (hypothesis.channels.some((channel) => !campaign.requestedChannels.includes(String(channel).toLowerCase()))) errors.push(`Contract v4 creative hypothesis ${id || index + 1} uses an unselected channel`);
    });
    if (!Array.isArray(creativeSystem?.approved_claim_ids)) errors.push('Contract v4 approved claim ids must be an array');
    else if (creativeSystem.approved_claim_ids.some((id) => !evidenceIds.has(String(id)))) errors.push('Contract v4 approved claim ids reference unknown evidence');
    else if (creativeSystem.approved_claim_ids.some((id) => evidenceStatuses.get(String(id)) !== 'verified')) errors.push('Contract v4 approved claim ids must reference only verified evidence');
    actions.forEach((action, index) => {
      const id = String(action?.id || index + 1);
      const hypothesisId = String(action?.hypothesis_id || '');
      if (!hypothesisIds.has(hypothesisId)) errors.push(`Contract v4 action ${id} must reference a creative hypothesis`);
      if (!Array.isArray(action?.dependencies)) errors.push(`Contract v4 action ${id} dependencies must be an array`);
      if (!String(action?.success_measure || '').trim()) errors.push(`Contract v4 action ${id} needs a success measure`);
      if (!String(action?.rollback_or_exit || '').trim()) errors.push(`Contract v4 action ${id} needs a rollback or exit condition`);
      if (action?.claim_status === 'verified' && (!Array.isArray(action.evidence_ids) || action.evidence_ids.some((evidenceId) => evidenceStatuses.get(String(evidenceId)) !== 'verified'))) errors.push(`Contract v4 action ${id} verified claims must reference only verified evidence`);
      if (action?.claim_status === 'verified' && Array.isArray(action.evidence_ids)) {
        const unsupported = unsupportedEvidenceMarkers(action.final_copy, action.evidence_ids.map((evidenceId) => evidenceClaims.get(String(evidenceId)) || ''));
        if (unsupported.length) errors.push(`Contract v4 action ${id} contains claims not present in its evidence: ${unsupported.join(', ')}`);
      }
    });

    const launchPlan = bundle.launch_plan;
    if (!launchPlan || typeof launchPlan !== 'object' || Array.isArray(launchPlan)) errors.push('Contract v4 needs a launch plan');
    else {
      if (launchPlan.mode !== 'draft_only') errors.push('Contract v4 launch plan must remain draft only');
      if (!String(launchPlan.approval_mode || '').trim()) errors.push('Contract v4 launch plan needs an approval mode');
      for (const field of ['prerequisites', 'blocked_by', 'ceilings']) if (!Array.isArray(launchPlan[field])) errors.push(`Contract v4 launch plan ${field} must be an array`);
      for (const field of ['verification_steps', 'rollback_steps']) if (!Array.isArray(launchPlan[field]) || !launchPlan[field].length) errors.push(`Contract v4 launch plan ${field} must not be empty`);
    }

    const monitoringPlan = bundle.monitoring_plan;
    if (!monitoringPlan || typeof monitoringPlan !== 'object' || Array.isArray(monitoringPlan)) errors.push('Contract v4 needs a monitoring plan');
    else {
      for (const field of ['baseline', 'primary_outcome', 'attribution_limit']) if (!String(monitoringPlan[field] || '').trim()) errors.push(`Contract v4 monitoring plan needs ${field}`);
      const checkpoints = Array.isArray(monitoringPlan.checkpoints) ? monitoringPlan.checkpoints : [];
      if (!checkpoints.length) errors.push('Contract v4 monitoring plan needs checkpoints');
      checkpoints.forEach((checkpoint, index) => {
        if (!String(checkpoint?.timing || '').trim()) errors.push(`Contract v4 monitoring checkpoint ${index + 1} needs timing`);
        if (!Array.isArray(checkpoint?.metrics) || !checkpoint.metrics.length) errors.push(`Contract v4 monitoring checkpoint ${index + 1} needs metrics`);
        if (!String(checkpoint?.decision_rule || '').trim()) errors.push(`Contract v4 monitoring checkpoint ${index + 1} needs a decision rule`);
      });
      const expectedOptimizationApproval = String(campaign.autonomyMode || 'APPROVE_PLAN_ONCE').toUpperCase() !== 'FULL_AUTO';
      if (monitoringPlan.optimization_requires_approval !== expectedOptimizationApproval) {
        errors.push(`Contract v4 optimization_requires_approval must be ${expectedOptimizationApproval} for ${campaign.autonomyMode || 'APPROVE_PLAN_ONCE'}`);
      }
    }

    evidenceRows.forEach((item, index) => {
      if (!['company', 'connector', 'web', 'user', 'provider', 'derived'].includes(String(item?.source_type || ''))) errors.push(`Contract v4 evidence ${index + 1} needs a valid source type`);
      if (!['high', 'medium', 'low', 'none'].includes(String(item?.confidence || ''))) errors.push(`Contract v4 evidence ${index + 1} needs valid confidence`);
    });
    for (const check of ['evidence_integrity', 'creative_completeness', 'launch_safety', 'measurement_readiness']) {
      if (bundle.quality_gate?.checks?.[check] !== 'passed') errors.push(`Contract v4 quality check ${check} must pass`);
    }
  }
  return [...new Set(errors)];
}

function renderBundleReport(bundle) {
  const authored = String(bundle.report_markdown || '').trim();
  if (authored) return authored;
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
    let visualActionCount = 0;
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
      const creativeBrief = normalizeCreativeBrief(action.creative_brief);
      const createdAction = await tx.campaignAction.create({ data: {
        campaignId: run.campaignId, planVersionId: plan.id, audienceMemberId, channel: action.channel,
        actionType: actionType(action.channel), position, status: 'READY',
        scheduledAt: new Date(now + action.scheduled_offset_minutes * 60_000),
        payload: {
          ...action.payload,
          final_copy: action.final_copy,
          title: action.title || action.id,
          evidence: action.evidence || [],
          evidence_ids: action.evidence_ids || [],
          claim_status: action.claim_status || 'no_claim',
          hypothesis_id: action.hypothesis_id || null,
          dependencies: action.dependencies || [],
          rollback_or_exit: action.rollback_or_exit || null,
          creative_brief: creativeBrief,
          source_action_id: String(action.id),
          scheduled_offset_minutes: action.scheduled_offset_minutes,
        },
        rationale: String(action.rationale || ''), successMetric: String(action.success_measure || action.success_metric || '').slice(0, 200) || null,
        idempotencyKey: `plan:${version}:action:${String(action.id).slice(0, 100)}`,
      } });
      if (creativeBrief.required) {
        visualActionCount += 1;
        await tx.campaignAsset.create({ data: {
          campaignId: run.campaignId, actionId: createdAction.id, kind: 'IMAGE', status: 'QUEUED',
          provider: 'openrouter', model: DEFAULT_CAMPAIGN_IMAGE_MODEL,
          prompt: buildCampaignImagePrompt(creativeBrief, { goal: run.campaign.goal }),
          metadata: { creative_brief: creativeBrief, alt_text: creativeBrief.alt_text, aspect_ratio: creativeBrief.aspect_ratio, source: 'campaign_room', variant_index: 0 },
        } });
      }
    }
    // The operating plan is useful before a visual render finishes. Keep images
    // as asynchronous action work; launch preflight still requires each selected
    // required asset, but the Room and dashboard do not wait on the image queue.
    await tx.campaign.update({ where: { id: run.campaignId }, data: {
      status: 'READY_FOR_APPROVAL', currentPlanVersionId: plan.id, approvedPlanVersionId: null, lastError: null,
    } });
    await tx.campaignChannel.updateMany({ where: { campaignId: run.campaignId }, data: { status: 'READY' } });
    await tx.campaignRun.update({ where: { id: run.id }, data: {
      status: 'COMPLETED', validation: { valid: true, bundle_hash: bundleHash }, completedAt: new Date(), error: null,
    } });
    await tx.campaignEvent.create({ data: {
      campaignId: run.campaignId, orgId: run.campaign.orgId, eventType: 'campaign_plan_ready',
      data: {
        plan_version_id: plan.id,
        version,
        canonical_hash: bundleHash,
        contract_version: Number(bundle.contract_version || 1),
        action_count: bundle.actions.length,
        visual_action_count: visualActionCount,
        hypothesis_count: Array.isArray(bundle.creative_system?.hypotheses) ? bundle.creative_system.hypotheses.length : 0,
        evidence_count: Array.isArray(bundle.evidence) ? bundle.evidence.length : 0,
        launch_blocker_count: Array.isArray(bundle.launch_plan?.blocked_by) ? bundle.launch_plan.blocked_by.length : 0,
      },
    } });
    await tx.campaignEvent.create({ data: { campaignId: run.campaignId, orgId: run.campaign.orgId, eventType: 'campaign_ready', data: {
      campaign_id: run.campaignId, room_id: run.campaign.roomId, turn_id: run.turnId, plan_version_id: plan.id,
      display: { title: run.campaign.name, objective: run.campaign.objective, channels: run.campaign.requestedChannels, action_count: bundle.actions.length, status: 'READY_FOR_APPROVAL', message: visualActionCount ? 'Your campaign plan is ready. Visuals are generating for selected actions.' : 'Your campaign plan is ready to review.' },
    } } });
    if (visualActionCount) await tx.campaignEvent.create({ data: { campaignId: run.campaignId, orgId: run.campaign.orgId, eventType: 'campaign_asset_generation_queued', data: { plan_version_id: plan.id, action_count: visualActionCount, source: 'campaign_room' } } });
    return { ok: true, campaignId: run.campaignId, planVersionId: plan.id, version, status: 'READY_FOR_APPROVAL', visualActionCount };
  });
}

function affectedCampaignActionIds(errors = []) {
  const ids = new Set();
  for (const error of errors) {
    const match = String(error).match(/(?:X |Gmail |TARA )?action\s+([^\s:;,]+)/i);
    if (match?.[1] && !/^\d+$/.test(match[1])) ids.add(match[1]);
  }
  return ids;
}

export const __campaignRepairTest = { affectedCampaignActionIds };

export async function persistCampaignRepairingBundle({ prisma, turnId, bundle, errors, exhausted = false }) {
  const run = await prisma.campaignRun.findUnique({ where: { turnId }, include: { campaign: true } });
  if (!run || !bundle || !Array.isArray(bundle.actions)) return null;
  const cleanErrors = (Array.isArray(errors) ? errors : []).map((value) => String(value).slice(0, 500)).slice(0, 50);
  const affected = affectedCampaignActionIds(cleanErrors);
  const hash = canonicalHash({ bundle, errors: cleanErrors, exhausted });
  return prisma.$transaction(async (tx) => {
    const existing = await tx.campaignPlanVersion.findFirst({ where: { campaignId: run.campaignId, canonicalHash: hash } });
    if (existing) return { ok: false, duplicate: true, campaignId: run.campaignId, planVersionId: existing.id, status: 'NEEDS_REPAIR' };
    const latest = await tx.campaignPlanVersion.findFirst({ where: { campaignId: run.campaignId }, orderBy: { version: 'desc' }, select: { version: true } });
    const version = Number(latest?.version || 0) + 1;
    const plan = await tx.campaignPlanVersion.create({ data: {
      campaignId: run.campaignId, version, status: 'NEEDS_REPAIR', canonicalHash: hash,
      bundle: { ...bundle, repair: { errors: cleanErrors, affected_action_ids: [...affected], exhausted } },
      reportMarkdown: renderBundleReport(bundle),
      validation: { valid: false, errors: cleanErrors, affected_action_ids: [...affected], repair_exhausted: exhausted },
    } });
    for (const [position, action] of bundle.actions.entries()) {
      const sourceId = String(action?.id || `action_${position + 1}`);
      const actionAffected = affected.has(sourceId) || (!affected.size && cleanErrors.length > 0);
      await tx.campaignAction.create({ data: {
        campaignId: run.campaignId, planVersionId: plan.id,
        channel: String(action?.channel || 'unknown').slice(0, 40), actionType: actionType(action?.channel), position,
        status: actionAffected ? (exhausted ? 'NEEDS_ATTENTION' : 'REPAIRING') : 'READY',
        scheduledAt: Number.isInteger(action?.scheduled_offset_minutes)
          ? new Date(Date.now() + action.scheduled_offset_minutes * 60_000) : null,
        payload: { ...(action?.payload || {}), final_copy: action?.final_copy || '', source_action_id: sourceId,
          governance_errors: actionAffected ? cleanErrors.filter((error) => error.includes(sourceId)) : [] },
        rationale: String(action?.rationale || ''),
        successMetric: String(action?.success_measure || action?.success_metric || '').slice(0, 200) || null,
        idempotencyKey: `plan:${version}:action:${sourceId.slice(0, 100)}`,
        lastError: actionAffected ? cleanErrors.join('; ').slice(0, 2000) : null,
      } });
    }
    await tx.campaign.update({ where: { id: run.campaignId }, data: {
      status: 'NEEDS_REPAIR', currentPlanVersionId: plan.id, lastError: cleanErrors.join('; ').slice(0, 2000),
    } });
    await tx.campaignRun.update({ where: { id: run.id }, data: {
      status: 'NEEDS_INPUT', validation: { valid: false, errors: cleanErrors, plan_version_id: plan.id },
      error: cleanErrors.join('; '), completedAt: new Date(),
    } });
    await tx.campaignEvent.create({ data: {
      campaignId: run.campaignId, orgId: run.campaign.orgId, eventType: 'campaign_plan_needs_repair',
      data: { plan_version_id: plan.id, version, affected_action_ids: [...affected], errors: cleanErrors, repair_exhausted: exhausted },
    } });
    return { ok: false, campaignId: run.campaignId, planVersionId: plan.id, version, status: 'NEEDS_REPAIR', errors: cleanErrors };
  });
}

export async function markCampaignNeedsInput({ prisma, turnId, errors }) {
  const run = await prisma.campaignRun.findUnique({ where: { turnId }, include: { campaign: { select: { orgId: true } } } });
  if (!run) return null;
  const cleanErrors = (Array.isArray(errors) ? errors : []).map((item) => String(item).slice(0, 500)).slice(0, 30);
  await prisma.$transaction([
    prisma.campaign.update({ where: { id: run.campaignId }, data: { status: 'NEEDS_INPUT', lastError: cleanErrors.join('; ') || 'Campaign bundle validation failed' } }),
    prisma.campaignRun.update({ where: { id: run.id }, data: { status: 'NEEDS_INPUT', validation: { valid: false, errors: cleanErrors }, error: cleanErrors.join('; '), completedAt: new Date() } }),
    prisma.campaignEvent.create({ data: { campaignId: run.campaignId, orgId: run.campaign.orgId, eventType: 'campaign_governance_unmet', data: { unmet_deliverables: cleanErrors } } }),
  ]);
  return { campaignId: run.campaignId };
}

export function normalizeCampaignInput(body = {}) {
  const goal = cleanText(body.goal, 8000, 'Goal', true);
  const objective = String(body.objective || 'CUSTOM').trim().toUpperCase();
  if (!OBJECTIVES.has(objective)) throw campaignError('Unknown campaign objective', 400, 'invalid_objective');
  const channels = [...new Set((Array.isArray(body.channels) ? body.channels : []).map((value) => String(value).trim().toLowerCase()).filter(Boolean))];
  if (!channels.length) throw campaignError('Select at least one campaign channel', 400, 'channels_required');
  const unsupported = channels.filter((channel) => !KNOWN_CHANNELS.has(channel));
  if (unsupported.length) throw campaignError(`Unknown campaign channels: ${unsupported.join(', ')}`, 400, 'unknown_campaign_channel');
  const autonomyMode = String(body.autonomy_mode || 'APPROVE_PLAN_ONCE').trim().toUpperCase();
  if (!['FULL_AUTO', 'APPROVE_PLAN_ONCE', 'REVIEW_EVERY_ACTION'].includes(autonomyMode)) throw campaignError('Unknown approval mode');
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
    ...channels.map((channel) => ({ id: `channel:${channel}`, text: `Produce approval-ready ${channel} actions and state every launch prerequisite`, source: 'channel' })),
  ];
  const cadence = campaignActionRanges({ durationDays, intensity: body.intensity || body.cadence?.preset || 'FOCUSED', channels });
  return {
    name, goal, objective, channels, autonomyMode, creationKey, requirements,
    sourceType: cleanText(body.source_type, 40, 'Source type') || null,
    sourceId: cleanText(body.source_id, 80, 'Source id') || null,
    runtimeLink: body.runtime_link && typeof body.runtime_link === 'object' ? body.runtime_link : null,
    brief: {
      offer: cleanText(body.offer, 2000, 'Offer'), cta: cleanText(body.cta, 1000, 'CTA'),
      destination_url: validateDestinationUrl(cleanText(body.destination_url, 2048, 'Destination URL')),
      // `brief` is a strict whitelist, so an unlisted key is silently dropped. The link
      // policy has to live here or the preflight decision never reaches the Room and the
      // Room re-derives it — the drift this whole change exists to remove.
      link_policy: ['single_approved_url', 'linkless'].includes(String(body.link_policy || ''))
        ? String(body.link_policy) : null,
      link_policy_reason: cleanText(body.link_policy_reason, 300, 'Link policy reason'),
      geography: cleanStringList(body.geography, 100, 160, 'Geography'),
      languages: cleanStringList(body.languages, 50, 80, 'Languages'),
      duration_days: durationDays, cadence,
      brand_constraints: cleanText(body.brand_constraints, 4000, 'Brand constraints'),
      prohibited_claims: cleanText(body.prohibited_claims, 4000, 'Prohibited claims'),
      success_metrics: cleanStringList(body.success_metrics, 30, 160, 'Success metrics'),
    },
    audiencePolicy: body.audience || { mode: 'existing_first', discover_if_insufficient: true },
    schedulePolicy: { timezone, start: 'immediate_after_approval' },
  };
}

const HYPERAGENTS_ORGANIC_CHANNEL_PRIORITY = [
  'x_organic', 'linkedin', 'instagram', 'facebook', 'tiktok', 'youtube',
  'pinterest', 'reddit', 'threads', 'bluesky', 'google_business',
];

// A director can propose a channel, but it cannot make an unavailable account
// executable. HyperAgents handoffs therefore converge on the organization’s
// live connected organic surface instead of failing after the user asked for
// the strongest connected channels.
export function resolveHyperagentsOrganicChannels(requestedChannels, capabilities) {
  const ready = new Set((capabilities?.channels || [])
    .filter((channel) => channel?.execution_ready && channel?.executable)
    .map((channel) => String(channel.id || '').toLowerCase()));
  const requested = Array.isArray(requestedChannels)
    ? requestedChannels.map((channel) => String(channel || '').toLowerCase())
    : [];
  const requestedReady = requested.filter((channel) => ready.has(channel));
  if (requestedReady.length) return [...new Set(requestedReady)];
  return HYPERAGENTS_ORGANIC_CHANNEL_PRIORITY.filter((channel) => ready.has(channel)).slice(0, 3);
}

export async function createCampaign({ prisma, userId, orgId, body }) {
  requireCampaignPlanning(orgId);
  const organization = await prisma.organization.findUnique({ where: { id: orgId }, select: { campaignAutonomyMode: true } });
  const defaultMode = organization?.campaignAutonomyMode === 'AUTO' ? 'FULL_AUTO' : 'APPROVE_PLAN_ONCE';
  let input = normalizeCampaignInput({ ...body, autonomy_mode: body?.autonomy_mode || defaultMode });
  const existing = await prisma.campaign.findUnique({
    where: { orgId_ownerUserId_creationKey: { orgId, ownerUserId: userId, creationKey: input.creationKey } },
    include: { runs: { orderBy: { createdAt: 'desc' }, take: 1 }, channels: true },
  }).catch(() => null);
  if (existing) return { campaign: existing, created: false, dispatch: null };

  const capabilities = await getCampaignCapabilities({ prisma, userId, orgId });
  let unavailable = input.channels.filter((id) => !capabilities.channels.find((item) => item.id === id)?.planning_ready);
  if (unavailable.length && body?.trigger_surface === 'hyperagents') {
    const connectedOrganicChannels = resolveHyperagentsOrganicChannels(input.channels, capabilities);
    if (connectedOrganicChannels.length) {
      input = normalizeCampaignInput({
        ...body,
        channels: connectedOrganicChannels,
        autonomy_mode: body?.autonomy_mode || defaultMode,
      });
      unavailable = input.channels.filter((id) => !capabilities.channels.find((item) => item.id === id)?.planning_ready);
    }
  }
  if (unavailable.length) throw campaignError(`Campaign planning is unavailable for: ${unavailable.join(', ')}`, 409, 'channel_planning_unavailable');

  const participants = await prisma.digitalEmployee.findMany({
    where: campaignAgentWhere(orgId),
    select: { id: true }, orderBy: { createdAt: 'asc' }, take: 5,
  });
  if (!participants.length) throw campaignError('Complete company onboarding before creating a campaign', 409, 'campaign_team_required');
  const participantIds = participants.map((item) => item.id);

  const campaignId = crypto.randomUUID();
  const room = await prisma.$transaction(async (tx) => {
    await tx.$executeRawUnsafe('SELECT pg_advisory_xact_lock(hashtext($1))', `campaign-intelligence-room:${orgId}`);
    let fixedRoom = await tx.hyperRoom.findFirst({
      where: { orgId, roomTag: 'campaign', archivedAt: null, agentConnectors: { path: ['_domain_home'], equals: true } },
      orderBy: { createdAt: 'asc' },
    });
    if (!fixedRoom) {
      fixedRoom = await tx.hyperRoom.findFirst({ where: { orgId, roomTag: 'campaign', archivedAt: null }, orderBy: { updatedAt: 'desc' } });
    }
    const roomData = {
      name: 'Campaign Intelligence',
      goal: 'Turn company truth into debated, channel-ready campaigns with explicit launch approval and measurement.',
      participantIds,
      permanentLeadId: participantIds[0],
      roomTag: 'campaign',
      qualityMode: 'best',
      agentConnectors: { ...(fixedRoom?.agentConnectors || {}), _domain_home: true, _domain_version: 1 },
    };
    return fixedRoom
      ? tx.hyperRoom.update({ where: { id: fixedRoom.id }, data: roomData })
      : tx.hyperRoom.create({ data: { id: crypto.randomUUID(), userId, orgId, template: 'auto', enabledConnectors: [], ...roomData } });
  }, { timeout: 15000 });
  const roomId = room.id;
  const turnId = crypto.randomUUID();
  const lastTurn = await prisma.hyperTurn.findFirst({ where: { roomId }, orderBy: { seq: 'desc' }, select: { seq: true } });
  const campaignDraft = {
    id: campaignId, orgId, ownerUserId: userId, name: input.name, goal: input.goal,
    objective: input.objective, requestedChannels: input.channels, brief: input.brief,
    audiencePolicy: input.audiencePolicy,
  };
  const kickoff = buildCampaignDisplayMessage(campaignDraft);
  const briefSnapshot = {
    ...input,
    campaign_id: campaignId,
    channel_capabilities: capabilities.channels
      .filter((channel) => input.channels.includes(channel.id))
      .map(campaignCapabilitySnapshot),
    capabilities_checked_at: capabilities.checked_at,
  };
  const enabledConnectors = Array.from(new Set([
    ...(Array.isArray(room.enabledConnectors) ? room.enabledConnectors : []),
    ...(input.channels.includes('gmail') ? ['gmail'] : []),
  ]));
  const [, campaign, turn, run] = await prisma.$transaction([
    prisma.hyperRoom.update({ where: { id: roomId }, data: { enabledConnectors } }),
    prisma.campaign.create({ data: {
      id: campaignId, orgId, ownerUserId: userId, creationKey: input.creationKey, name: input.name,
      objective: input.objective, goal: input.goal, brief: input.brief, requirements: input.requirements,
      requestedChannels: input.channels, audiencePolicy: input.audiencePolicy,
      schedulePolicy: input.schedulePolicy, autonomyMode: input.autonomyMode,
      sourceType: input.sourceType, sourceId: input.sourceId,
      roomId, status: 'GENERATING',
    } }),
    prisma.hyperTurn.create({ data: {
      id: turnId, roomId, seq: (lastTurn?.seq || 0) + 1, userMessage: kickoff, status: 'live',
      idempotencyKey: `campaign-kickoff-${campaignId}`, lines: [],
      runtimePlaybookRunId: input.runtimeLink?.run_id || null,
      runtimeStageId: input.runtimeLink?.stage_id || null,
      runtimeCheckpointSequence: Number.isInteger(input.runtimeLink?.checkpoint_sequence) ? input.runtimeLink.checkpoint_sequence : null,
      runtimeAttempt: Number.isInteger(input.runtimeLink?.attempt) ? input.runtimeLink.attempt : null,
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
  requireCampaignPlanning(orgId);
  return prisma.campaign.findMany({
    where: { orgId, status: { not: 'CANCELLED' } }, orderBy: { createdAt: 'desc' },
    include: { channels: true, runs: { orderBy: { createdAt: 'desc' }, take: 1 }, approvals: { where: { status: 'ACTIVE' }, orderBy: { approvedAt: 'desc' }, take: 1 }, _count: { select: { actions: true } } },
  });
}

export async function getCampaign({ prisma, orgId, userId = null, id }) {
  requireCampaignPlanning(orgId);
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
  const campaignTurnIds = campaign.runs.map((run) => run.turnId).filter(Boolean);
  const roomTranscript = campaign.roomId && campaignTurnIds.length ? await prisma.hyperTurn.findMany({
    where: { roomId: campaign.roomId, id: { in: campaignTurnIds } }, orderBy: { seq: 'asc' }, take: 20,
    select: { id: true, seq: true, status: true, lines: true, startedAt: true, sealedAt: true },
  }) : [];
  const currentActions = campaign.currentPlanVersionId
    ? campaign.actions.filter((action) => action.planVersionId === campaign.currentPlanVersionId)
    : [];
  const currentPlan = campaign.currentPlanVersionId
    ? campaign.planVersions.find((plan) => plan.id === campaign.currentPlanVersionId)
    : null;
  const capabilities = userId ? await getCampaignCapabilities({ prisma, userId, orgId }).catch(() => null) : null;
  const planIntegrity = currentPlan
    ? canonicalHash(currentPlan.bundle) === currentPlan.canonicalHash && validateCampaignBundle(currentPlan.bundle, campaign).length === 0
    : false;
  const readiness = assessCampaignReadiness({
    campaign, plan: currentPlan, actions: currentActions, assets: campaign.assets,
    capabilities, planIntegrity,
  });
  const safeAsset = (asset) => {
    const { storageKey, ...safe } = asset;
    return { ...safe, content_url: storageKey && !asset.deletedAt ? `/v1/campaigns/${asset.campaignId}/assets/${asset.id}/content` : null };
  };
  return {
    ...campaign,
    assets: campaign.assets.map(safeAsset),
    actions: currentActions.map((action) => ({ ...action, assets: action.assets.map(safeAsset) })),
    events: campaign.events.map((event) => ({ ...event, id: String(event.id) })),
    roomTranscript,
    readiness,
  };
}

export async function deleteCampaign({ prisma, orgId, userId, id }) {
  requireCampaignPlanning(orgId);
  const campaign = await prisma.campaign.findFirst({ where: { id, orgId, status: { not: 'CANCELLED' } } });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  await requireCampaignEditor(prisma, campaign, userId);
  const now = new Date();
  await prisma.$transaction([
    prisma.campaign.update({ where: { id }, data: { status: 'CANCELLED', cancelledAt: now, lastError: null } }),
    prisma.campaignAction.updateMany({
      where: { campaignId: id, status: { in: ['READY', 'QUEUED', 'PAUSED', 'FAILED', 'BLOCKED'] } },
      data: { status: 'CANCELLED', leaseOwner: null, leaseExpiresAt: null },
    }),
    prisma.campaignChannel.updateMany({ where: { campaignId: id }, data: { status: 'CANCELLED' } }),
    prisma.campaignApproval.updateMany({ where: { campaignId: id, status: 'ACTIVE' }, data: { status: 'REVOKED', revokedAt: now } }),
    prisma.campaignEvent.create({ data: {
      campaignId: id, orgId, eventType: 'campaign_deleted', actorType: 'user', actorId: userId,
      data: { soft_delete: true, cancelled_at: now.toISOString() },
    } }),
  ]);
  return { deleted: true, campaignId: id };
}

async function requireCampaignEditor(prisma, campaign, userId) {
  if (campaign.ownerUserId === userId) return;
  const membership = await prisma.userOrganization.findUnique({ where: { userId_orgId: { userId, orgId: campaign.orgId } }, select: { role: true } });
  if (['owner', 'admin'].includes(membership?.role)) return;
  throw campaignError('Only the campaign creator or an organization admin can change this campaign', 403, 'campaign_editor_required');
}

export async function getCampaignSettings({ prisma, orgId }) {
  requireCampaignPlanning(orgId);
  const organization = await prisma.organization.findUnique({
    where: { id: orgId }, select: { campaignAutonomyMode: true },
  });
  if (!organization) throw campaignError('Organization not found', 404, 'organization_not_found');
  return { autonomy_mode: organization.campaignAutonomyMode === 'AUTO' ? 'AUTO' : 'MANUAL_REVIEW' };
}

export async function updateCampaignSettings({ prisma, orgId, userId, autonomyMode }) {
  requireCampaignPlanning(orgId);
  const membership = await prisma.userOrganization.findUnique({
    where: { userId_orgId: { userId, orgId } }, select: { role: true },
  });
  if (!['owner', 'admin'].includes(membership?.role)) {
    throw campaignError('Only an organization owner or admin can change campaign autonomy', 403, 'campaign_settings_admin_required');
  }
  const normalized = String(autonomyMode || '').trim().toUpperCase();
  if (!['MANUAL_REVIEW', 'AUTO'].includes(normalized)) throw campaignError('Unknown campaign autonomy mode', 400, 'campaign_autonomy_invalid');
  await prisma.organization.update({ where: { id: orgId }, data: { campaignAutonomyMode: normalized } });
  return { autonomy_mode: normalized };
}

export async function autoLaunchCampaignIfReady({ prisma, campaignId, clock = () => new Date() }) {
  const campaign = await prisma.campaign.findUnique({
    where: { id: campaignId }, select: { id: true, orgId: true, ownerUserId: true, autonomyMode: true, status: true },
  });
  if (!campaign || campaign.autonomyMode !== 'FULL_AUTO' || campaign.status !== 'READY_FOR_APPROVAL') return { launched: false };
  try {
    const result = await approveCampaign({ prisma, orgId: campaign.orgId, userId: campaign.ownerUserId, id: campaign.id, clock });
    await prisma.campaignEvent.create({ data: {
      campaignId: campaign.id, orgId: campaign.orgId, eventType: 'campaign_auto_launched',
      actorType: 'system', actorId: campaign.ownerUserId,
      data: { approval_id: result.approval.id, plan_version_id: result.launch.plan_version_id },
    } });
    return { launched: true, ...result };
  } catch (error) {
    await prisma.campaignEvent.create({ data: {
      campaignId: campaign.id, orgId: campaign.orgId, eventType: 'campaign_auto_launch_waiting',
      actorType: 'system', actorId: campaign.ownerUserId,
      data: { error: String(error?.message || error).slice(0, 1000), code: error?.code || null },
    } });
    return { launched: false, waiting: true, error };
  }
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
  const visualActions = approvedActions.filter((action) => action.payload?.creative_brief?.required === true);
  const selectedAssetIds = visualActions.map((action) => String(action.payload?.asset_id || '')).filter(Boolean);
  if (selectedAssetIds.length !== visualActions.length) throw campaignError('Every required campaign visual must have a selected image before launch', 409, 'campaign_assets_not_ready');
  const selectedAssets = selectedAssetIds.length ? await prisma.campaignAsset.findMany({
    where: { id: { in: selectedAssetIds }, campaignId: id, status: 'READY', deletedAt: null },
    select: { id: true, actionId: true, kind: true, status: true, contentHash: true, contentType: true, sizeBytes: true, width: true, height: true, metadata: true, deletedAt: true },
  }) : [];
  const assetsById = new Map(selectedAssets.map((asset) => [asset.id, asset]));
  for (const action of visualActions) {
    const asset = assetsById.get(String(action.payload.asset_id));
    if (!asset || asset.actionId !== action.id || asset.contentHash !== action.payload.asset_hash) throw campaignError('A selected campaign image changed or is no longer ready', 409, 'campaign_asset_changed');
  }
  const actionHashes = Object.fromEntries(approvedActions.map((action) => [action.id, canonicalHash(action.payload)]));
  const capabilities = await getCampaignCapabilities({ prisma, userId: campaign.ownerUserId, orgId });
  const unavailable = campaign.requestedChannels.filter((channel) => !capabilities.channels.find((item) => item.id === channel)?.execution_ready);
  if (unavailable.length) throw campaignError(`Execution is not ready for: ${unavailable.join(', ')}`, 409, 'channel_execution_unavailable');
  const readiness = assessCampaignReadiness({
    campaign, plan, actions: approvedActions, assets: selectedAssets, capabilities, planIntegrity: true,
  });
  if (readiness.decision !== 'ready') {
    throw campaignError(
      readiness.blockers.map((item) => item.detail).join(' '),
      409,
      'campaign_readiness_blocked',
      readiness,
    );
  }
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
    if (selectedAssetIds.length) await tx.campaignAsset.updateMany({ where: { id: { in: selectedAssetIds }, campaignId: id, status: 'READY' }, data: { status: 'APPROVED' } });
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
  requireCampaignPlanning(orgId);
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
  requireCampaignPlanning(orgId);
  const campaign = await prisma.campaign.findFirst({ where: { id, orgId } });
  if (!campaign) throw campaignError('Campaign not found', 404, 'campaign_not_found');
  await requireCampaignEditor(prisma, campaign, userId);
  if (!['READY_FOR_APPROVAL', 'NEEDS_INPUT', 'NEEDS_REPAIR', 'FAILED'].includes(campaign.status) || !campaign.roomId) {
    throw campaignError('This campaign cannot be regenerated in its current state', 409, 'campaign_regeneration_unavailable');
  }
  const room = await prisma.hyperRoom.findUnique({ where: { id: campaign.roomId } });
  if (!room) throw campaignError('Campaign Room not found', 409, 'campaign_room_missing');
  const participantIds = Array.isArray(room.participantIds) ? room.participantIds : [];
  if (!participantIds.length) throw campaignError('Campaign Room has no active agents', 409, 'campaign_team_required');
  const cleanFeedback = cleanText(feedback, 4000, 'Regeneration feedback');
  const existingBrief = campaign.brief && typeof campaign.brief === 'object' ? campaign.brief : {};
  const existingCadence = existingBrief.cadence && typeof existingBrief.cadence === 'object' ? existingBrief.cadence : {};
  const normalizedBrief = {
    ...existingBrief,
    duration_days: Number(existingBrief.duration_days || 14),
    cadence: Object.keys(existingCadence.expected_actions_by_channel || {}).length
      ? existingCadence
      : campaignActionRanges({
        durationDays: existingBrief.duration_days || 14,
        intensity: existingCadence.preset || 'FOCUSED',
        channels: campaign.requestedChannels,
      }),
  };
  const capabilities = await getCampaignCapabilities({ prisma, userId, orgId });
  const result = await prisma.$transaction(async (tx) => {
    const claimed = await tx.campaign.updateMany({
      where: { id, orgId, status: { in: ['READY_FOR_APPROVAL', 'NEEDS_INPUT', 'NEEDS_REPAIR', 'FAILED'] } },
      data: { status: 'GENERATING', currentPlanVersionId: null, approvedPlanVersionId: null, lastError: null },
    });
    if (!claimed.count) throw campaignError('Campaign regeneration was already started', 409, 'campaign_regeneration_conflict');
    await tx.hyperRoom.update({ where: { id: room.id }, data: { roomTag: 'campaign' } });
    const lastTurn = await tx.hyperTurn.findFirst({ where: { roomId: room.id }, orderBy: { seq: 'desc' }, select: { seq: true } });
    const kickoff = buildCampaignDisplayMessage(campaign, cleanFeedback);
    const turn = await tx.hyperTurn.create({ data: {
      roomId: room.id, seq: (lastTurn?.seq || 0) + 1, userMessage: kickoff, status: 'live',
      idempotencyKey: `campaign-regen-${crypto.randomUUID()}`, lines: [],
    } });
    const briefSnapshot = {
      name: campaign.name, goal: campaign.goal, objective: campaign.objective, channels: campaign.requestedChannels,
      autonomyMode: campaign.autonomyMode, requirements: campaign.requirements, brief: normalizedBrief,
      audiencePolicy: campaign.audiencePolicy, schedulePolicy: campaign.schedulePolicy, campaign_id: id,
      feedback: cleanFeedback || undefined,
      channel_capabilities: capabilities.channels
        .filter((channel) => campaign.requestedChannels.includes(channel.id))
        .map(campaignCapabilitySnapshot),
      capabilities_checked_at: capabilities.checked_at,
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
  return getCampaign({ prisma, orgId, userId, id });
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
    const livePaidActions = await prisma.campaignAction.findMany({
      where: { campaignId: id, channel: { in: ['x_ads', 'google_ads', 'meta', 'linkedin_ads', 'tiktok_ads', 'pinterest_ads'] }, status: 'SUCCEEDED', externalId: { not: null } },
      include: { campaign: true },
    });
    for (const campaignAction of livePaidActions) await pauseCampaignAction({ prisma, action: campaignAction });
    await prisma.$transaction([
      prisma.campaign.update({ where: { id }, data: { status: 'PAUSED', pausedAt: new Date() } }),
      prisma.campaignAction.updateMany({ where: { campaignId: id, status: 'QUEUED' }, data: { status: 'PAUSED' } }),
      prisma.campaignChannel.updateMany({ where: { campaignId: id }, data: { status: 'PAUSED' } }),
      prisma.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_paused', actorType: 'user', actorId: userId, data: { provider_ads_paused: livePaidActions.length } } }),
    ]);
  } else if (action === 'resume') {
    if (!campaignWorkerEnabled()) throw campaignError('Campaign execution is not enabled for this pilot yet', 409, 'campaign_execution_disabled');
    if (campaign.status !== 'PAUSED') throw campaignError('Only a paused campaign can be resumed', 409, 'campaign_not_paused');
    const capabilities = await getCampaignCapabilities({ prisma, userId: campaign.ownerUserId, orgId });
    const unavailable = campaign.requestedChannels.filter((channel) => !capabilities.channels.find((item) => item.id === channel)?.execution_ready);
    if (unavailable.length) throw campaignError(`Execution is not ready for: ${unavailable.join(', ')}`, 409, 'channel_execution_unavailable');
    const pausedPaidActions = await prisma.campaignAction.findMany({
      where: { campaignId: id, channel: { in: ['x_ads', 'google_ads', 'meta', 'linkedin_ads', 'tiktok_ads', 'pinterest_ads'] }, status: 'SUCCEEDED', externalId: { not: null } },
      include: { campaign: true },
    });
    for (const campaignAction of pausedPaidActions) await resumeCampaignAction({ prisma, action: campaignAction });
    await prisma.$transaction([
      prisma.campaign.update({ where: { id }, data: { status: 'RUNNING', pausedAt: null, lastError: null } }),
      prisma.campaignAction.updateMany({ where: { campaignId: id, status: 'PAUSED' }, data: { status: 'QUEUED' } }),
      prisma.campaignChannel.updateMany({ where: { campaignId: id }, data: { status: 'RUNNING' } }),
      prisma.campaignEvent.create({ data: { campaignId: id, orgId, eventType: 'campaign_resumed', actorType: 'user', actorId: userId, data: { provider_ads_resumed: pausedPaidActions.length } } }),
    ]);
  } else {
    throw campaignError('Unknown campaign control action', 404, 'unknown_campaign_action');
  }
  return getCampaign({ prisma, orgId, userId, id });
}

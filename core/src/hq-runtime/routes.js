import {
  appendHqEvent,
  ensureHqRuntime,
  FIRST_LIFE_OBJECTIVE,
  getHqRuntime,
  resetHqForCompanyReplacement,
  scheduleHqWake,
  transitionHqRuntime,
} from './repository.js';
import { reconcileTodoCapabilities } from './instruction-loop.js';
import { getHyperagentsRuntimeConnectorProvider, toComposioToolkit } from '../connectors/runtime-provider-policy.js';
import { loadRuntimePlaybookSnapshot, projectRuntimePlaybookSnapshot, terminalOutcomeSatisfied } from '../runtime-playbooks/snapshot.js';
import { stageAuthorityHash } from '../runtime-playbooks/stage-executor.js';
import { projectCurrentActivationSprint } from './activation-sprint.js';
import { activateEligibleFirstLifeWork } from './first-life-control.js';
import { normalizeAuthorityPolicy, resolveAuthorityPreference } from './contracts.js';
import { subscribeHqRuntimeEvents } from './event-bus.js';
import { recordRuntimeMetric } from './runtime-metrics.js';

const ACTIVE_STATES = new Set(['OBSERVING', 'DIAGNOSING', 'DELEGATING', 'WAITING', 'REVIEWING', 'BLOCKED']);

function asJsonEvent(row) {
  return {
    ...row,
    sequence: String(row.sequence),
    createdAt: row.createdAt?.toISOString?.() || row.createdAt,
  };
}

function asJsonRuntime(row) {
  if (!row) return null;
  return { ...row, eventSequence: String(row.eventSequence ?? 0) };
}

export function projectCampaignAuthorityPreview(campaign) {
  if (!campaign) return null;
  const actions = (campaign.actions || [])
    .filter((action) => !campaign.currentPlanVersionId || action.planVersionId === campaign.currentPlanVersionId)
    .map((action) => ({
      id: action.id,
      channel: action.channel,
      action_type: action.actionType,
      position: action.position,
      status: action.status,
      scheduled_at: action.scheduledAt?.toISOString?.() || action.scheduledAt || null,
      payload: action.payload || {},
      rationale: action.rationale || null,
      success_metric: action.successMetric || null,
      assets: (action.assets || []).filter((asset) => !asset.deletedAt).map((asset) => ({
        id: asset.id,
        status: asset.status,
        content_type: asset.contentType || null,
        width: asset.width || null,
        height: asset.height || null,
        metadata: asset.metadata || {},
        content_url: asset.storageKey
          ? `/v1/campaigns/${campaign.id}/assets/${asset.id}/content`
          : null,
      })),
    }));
  return {
    id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    channels: campaign.requestedChannels || [],
    plan_version_id: campaign.currentPlanVersionId || null,
    actions,
  };
}

export function projectRuntimeCampaignPreviews({ playbookRuns = [], campaignsByRun = new Map(), runtimeId, runtimeEpoch } = {}) {
  return playbookRuns.flatMap((run) => {
    if (String(run.trigger?.runtime_id || '') !== String(runtimeId || '')
      || String(run.trigger?.runtime_epoch || '') !== String(runtimeEpoch || '')) return [];
    const campaign = campaignsByRun.get(run.id);
    if (!campaign) return [];
    const preview = projectCampaignAuthorityPreview(campaign);
    return preview ? [{ ...preview, run_id: run.id, todo_id: run.trigger?.todo_id || null }] : [];
  });
}

function normalizedPhone(value) {
  const phone = String(value || '').replace(/[\s()/-]/g, '');
  return /^\+[1-9]\d{6,14}$/.test(phone) ? phone : null;
}

export function projectOutreachCallProposals({ playbookRuns = [], outreachTargets = [], todos = [], runtimeId = null, runtimeEpoch = null } = {}) {
  const targetById = new Map(outreachTargets.map((target) => [String(target.id), target]));
  const alreadyRequested = new Set(todos.map((todo) => String(todo.context?.source_outreach_run_id || '')).filter(Boolean));
  return playbookRuns.flatMap((run) => {
    if (run.playbookId !== 'outreach.prospect-to-conversation' || alreadyRequested.has(String(run.id))) return [];
    if (runtimeId && String(run.trigger?.runtime_id || '') !== String(runtimeId)) return [];
    if (runtimeEpoch && String(run.trigger?.runtime_epoch || '') !== String(runtimeEpoch)) return [];
    const messagesByLead = new Map(run.artifacts.filter((artifact) => artifact.artifactKey === 'message_record')
      .map((artifact) => [String(artifact.data?.lead_ref || ''), artifact.data]));
    const targets = run.artifacts.filter((artifact) => artifact.artifactKey === 'lead_record').flatMap((artifact) => {
      const persisted = targetById.get(String(artifact.data?.persistence_ref || '')) || {};
      const phone = normalizedPhone(artifact.data?.phone || persisted.phone);
      if (!phone) return [];
      const message = messagesByLead.get(String(artifact.artifactId || '')) || {};
      const inputContext = persisted.inputContext && typeof persisted.inputContext === 'object' ? persisted.inputContext : {};
      const personalNotes = [artifact.data?.personal_notes, inputContext.notes, inputContext.special_instruction]
        .map((value) => String(value || '').trim()).filter(Boolean).join('\n');
      return [{
        type: 'phone', value: phone,
        label: artifact.data?.company || persisted.company || phone,
        lead_ref: artifact.data?.persistence_ref || persisted.id || null,
        verified_email: message.recipient || persisted.email || null,
        personal_notes: personalNotes || null,
        goal: artifact.data?.outreach_angle || inputContext.outreach_angle || 'Understand the prospect\'s current priorities and determine whether a useful next conversation exists.',
        fit_rationale: artifact.data?.fit_rationale || inputContext.fit_rationale || null,
        source_refs: Array.isArray(artifact.sourceRefs) ? artifact.sourceRefs : [],
      }];
    });
    if (!targets.length) return [];
    return [{
      id: `outreach-calls:${run.id}`,
      source_run_id: run.id,
      source_todo_id: run.trigger?.todo_id || null,
      title: 'Start TARA outreach calls',
      summary: `${targets.length} verified prospect${targets.length === 1 ? '' : 's'} ready for sequential TARA outreach. Each call is analyzed before Runtime prepares the next one.`,
      targets,
    }];
  });
}

export function eventCursor(...values) {
  return values.reduce((highest, value) => {
    try {
      const parsed = BigInt(String(value || '0').trim() || '0');
      return parsed > highest ? parsed : highest;
    } catch {
      return highest;
    }
  }, 0n);
}

function tokenPair(usage = {}) {
  const input = Number(usage.prompt_tokens ?? usage.input_tokens ?? usage.inputTokens ?? 0) || 0;
  const output = Number(usage.completion_tokens ?? usage.output_tokens ?? usage.outputTokens ?? 0) || 0;
  return { input, output };
}

async function getHqUsage(prisma, orgId, since = null) {
  const createdAt = since ? { gte: since } : undefined;
  const [plans, workOrders, runtimeTurns] = await Promise.all([
    prisma.sourceArtifact.findMany({
      where: { orgId, sourcePlatform: 'growth_plan', artifactType: 'api_response', ...(createdAt ? { createdAt } : {}) },
      select: { payload: true }, take: 100,
    }),
    prisma.hyperWorkOrder.findMany({ where: { orgId, hqCycleId: { not: null }, ...(createdAt ? { createdAt } : {}) }, select: { id: true }, take: 500 }),
    prisma.hyperTurn.findMany({
      where: {
        runtimePlaybookRunId: { not: null },
        runtimePlaybookRun: { is: { orgId } },
        ...(since ? { startedAt: { gte: since } } : {}),
      },
      select: { lines: true }, take: 500,
    }),
  ]);
  const results = workOrders.length ? await prisma.hyperWorkResult.findMany({
    where: { workOrderId: { in: workOrders.map((row) => row.id) } }, select: { usage: true }, take: 500,
  }) : [];
  const roomUsage = runtimeTurns.map((turn) => {
    const lines = Array.isArray(turn.lines) ? turn.lines : [];
    const seal = [...lines].reverse().find((line) => line?.t === 'seal') || {};
    return { input_tokens: seal.tokens_in || 0, output_tokens: seal.tokens_out || 0 };
  });
  return [...plans.map((row) => row.payload?.usage || {}), ...results.map((row) => row.usage || {}), ...roomUsage]
    .reduce((total, usage) => { const value = tokenPair(usage); return { input_tokens: total.input_tokens + value.input, output_tokens: total.output_tokens + value.output }; }, { input_tokens: 0, output_tokens: 0 });
}

async function requireHqAccess({ req, res, requireSession, requirePrivilegedAgentAccess }) {
  const current = await requireSession(req, res);
  if (!current) return null;
  if (!await requirePrivilegedAgentAccess(req, res, current)) return null;
  return current;
}

async function findDefaultObjective(prisma, orgId) {
  const goal = await prisma.growthGoal.findFirst({
    where: { orgId, status: 'ACTIVE' }, orderBy: { updatedAt: 'desc' }, select: { objective: true },
  }).catch(() => null);
  if (goal?.objective) return goal.objective;
  const rows = await prisma.$queryRawUnsafe(
    `SELECT agent_connectors->'_company' AS company FROM hivemind.hyper_rooms
      WHERE org_id=$1::uuid AND archived_at IS NULL AND agent_connectors ? '_company'
      ORDER BY updated_at DESC LIMIT 1`, orgId,
  ).catch(() => []);
  const company = rows[0]?.company || {};
  return company.goal || company.mission || '';
}

async function requestWake({ prisma, runtime, triggerType, payload = {}, key }) {
  const dueAt = new Date();
  const idempotencyKey = key || `${triggerType}:${dueAt.toISOString().slice(0, 16)}`;
  return scheduleHqWake({
    prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
    idempotencyKey, triggerType, dueAt, payload,
  });
}

async function reconcileRuntimeCapabilities({ prisma, runtime, wakeScheduler }) {
  const result = await reconcileTodoCapabilities({ prisma, runtime });
  if (!result.resolved.length) return result;
  for (const resolved of result.resolved) {
    await appendHqEvent({
      prisma, runtimeId: runtime.id, orgId: runtime.orgId,
      eventType: 'capability_resolved', title: 'A required capability is available',
      summary: `${resolved.platform_managed?.length ? `${resolved.platform_managed.join(', ')} is provided by Singulance.` : `I verified ${resolved.capabilities.join(', ')} against this organization.`} The blocked todo is ready again and has returned to the operating queue.`,
      details: resolved,
    });
  }
  await requestWake({
    prisma, runtime, triggerType: 'connector_changed', payload: { resolved: result.resolved },
    key: `capability-reconciled:${runtime.id}:${result.resolved.map((item) => item.todo_id).join(':')}`,
  });
  Promise.resolve(wakeScheduler?.()).catch(() => {});
  return result;
}

function queueStatus(value) {
  const status = String(value || '').toUpperCase();
  if (status === 'PROPOSED') return 'PROPOSED';
  if (['COMPLETED', 'COMPLETE'].includes(status)) return 'COMPLETED';
  if (status === 'WAITING_FOR_CONNECTOR') return 'WAITING_FOR_CONNECTOR';
  if (status === 'WAITING_FOR_AUTHORITY') return 'WAITING_FOR_AUTHORITY';
  if (status === 'MONITORING' || status === 'WAITING_FOR_EVIDENCE') return 'MONITORING';
  if (['BLOCKED', 'NEEDS_ATTENTION', 'NEEDS_INTERVENTION', 'FAILED'].includes(status)) return 'NEEDS_ATTENTION';
  if (status === 'CANCELLED') return 'CANCELLED';
  if (['RUNNING', 'ACTIVE', 'QUEUED'].includes(status)) return 'RUNNING';
  return 'READY';
}

export function playbookQueueStatus(run) {
  const status = String(run?.status || '').toUpperCase();
  if (status === 'WAITING_EVENT') {
    const waitingTypes = Array.isArray(run?.waitingFor?.types) ? run.waitingFor.types : [];
    const projected = String(run?.waitingFor?.presentation?.task_status || '').toUpperCase();
    if (['RUNNING', 'MONITORING'].includes(projected)) return projected;
    return waitingTypes.includes('capability.connected') ? 'WAITING_FOR_CONNECTOR' : 'MONITORING';
  }
  if (status === 'WAITING_AUTHORITY') return 'WAITING_FOR_AUTHORITY';
  if (status === 'COMPLETED' && !terminalOutcomeSatisfied(run)) return 'NEEDS_ATTENTION';
  if (status === 'NEEDS_INTERVENTION' || status === 'TERMINATED') return 'NEEDS_ATTENTION';
  return queueStatus(status);
}

function runtimeQueue({ todos, stages, delegations }) {
  const stageById = new Map(stages.map((stage) => [stage.id, stage]));
  const todoRows = todos.map((todo) => ({
    id: `todo:${todo.id}`, source: 'todo', source_id: todo.id, title: todo.title,
    objective: todo.objective, status: queueStatus(todo.status), priority: todo.priority,
    position: todo.position, blocked_reason: todo.blockedReason || null, updated_at: todo.updatedAt,
  }));
  const stageRows = stages.map((stage) => {
    const stageDelegations = delegations.filter((delegation) => delegation.growthStageId === stage.id);
    const waitingForEvidence = String(stage.status).toUpperCase() === 'ACTIVE'
      && stage.checkpointAt && new Date(stage.checkpointAt).getTime() > Date.now()
      && stageDelegations.every((delegation) => ['COMPLETED', 'CANCELLED'].includes(String(delegation.status).toUpperCase()));
    return {
      id: `stage:${stage.id}`, source: 'growth_stage', source_id: stage.id, title: stage.name,
      objective: stage.objective, status: waitingForEvidence ? 'WAITING_FOR_EVIDENCE' : queueStatus(stage.status),
      priority: String(stage.status).toUpperCase() === 'ACTIVE' ? 10 : 80, position: 0,
      blocked_reason: waitingForEvidence ? `Review at ${new Date(stage.checkpointAt).toISOString()}` : null, updated_at: stage.updatedAt,
    };
  });
  const delegationRows = delegations.map((delegation) => ({
    id: `delegation:${delegation.id}`, source: 'growth_delegation', source_id: delegation.id,
    title: delegation.objective, objective: delegation.deliverable || delegation.objective,
    status: queueStatus(delegation.status), priority: stageById.get(delegation.growthStageId)?.status === 'ACTIVE' ? 15 : 90,
    position: 0, blocked_reason: null, updated_at: delegation.updatedAt,
  }));
  return [...todoRows, ...stageRows, ...delegationRows]
    .sort((left, right) => left.priority - right.priority || left.position - right.position || new Date(left.updated_at) - new Date(right.updated_at));
}

function projectAgentRuntimeTasks({ todos, playbookRuns, playbookOwners = new Map() }) {
  const runByTodo = new Map();
  for (const run of playbookRuns) {
    const todoId = String(run.trigger?.todo_id || '');
    if (todoId && !run.parentRunId && !runByTodo.has(todoId)) runByTodo.set(todoId, run);
  }
  return todos.map((todo) => {
    const run = runByTodo.get(String(todo.id)) || null;
    const snapshot = run ? projectRuntimePlaybookSnapshot(run) : null;
    const children = run ? playbookRuns.filter((candidate) => candidate.parentRunId === run.id)
      .sort((left, right) => Number(left.position ?? 0) - Number(right.position ?? 0)) : [];
    const activeChild = children.find((child) => !['COMPLETED', 'TERMINATED', 'NEEDS_INTERVENTION'].includes(String(child.status))) || null;
    const controllingRun = activeChild || run;
    const controllingSnapshot = controllingRun ? projectRuntimePlaybookSnapshot(controllingRun) : snapshot;
    const context = todo.context && typeof todo.context === 'object' ? todo.context : {};
    const status = controllingRun ? playbookQueueStatus(controllingRun) : queueStatus(todo.status);
    const waiting = controllingSnapshot?.waiting_for || null;
    const waitingSummary = waiting?.reason || waiting?.capability || waiting?.types?.join(', ') || null;
    return {
      id: todo.id,
      execution_id: run?.id || null,
      title: todo.title,
      objective: todo.objective,
      status,
      owner: context.runtime_owner_room_tag
        || playbookOwners.get(`${controllingRun?.playbookId || ''}@${controllingRun?.playbookVersion || ''}`)
        || context.room_tag || todo.kind || null,
      lifecycle_stage: controllingSnapshot?.current_stage || null,
      blocker: todo.blockedReason || (status === 'WAITING_FOR_CONNECTOR' || status === 'WAITING_FOR_AUTHORITY' ? waitingSummary : null),
      next_action: controllingSnapshot?.next_action || (status === 'PROPOSED' ? 'await_start' : status === 'READY' ? 'select_playbook' : null),
      checkpoint_sequence: controllingSnapshot?.checkpoint_sequence || 0,
      checkpoint_at: controllingRun?.updatedAt || todo.updatedAt,
      artifact_refs: controllingSnapshot?.artifact_refs || [],
      artifact_counts: controllingSnapshot?.artifact_counts || {},
      child_progress: children.length ? {
        total: children.length,
        settled: children.filter((child) => ['COMPLETED', 'TERMINATED', 'NEEDS_INTERVENTION'].includes(String(child.status))).length,
        current_recipient: activeChild?.context?.target?.label || activeChild?.context?.target?.value || activeChild?.itemKey || null,
        current_run_id: activeChild?.id || null,
        outcomes: children.map((child) => ({ item_key: child.itemKey, status: child.status, terminal_state: child.terminalState })),
      } : null,
      recommendation_rank: Number(context.recommendation_rank || todo.position + 1),
      recommended: context.recommended === true,
      effect_class: context.effect_class || (context.external_action_requested === true ? 'external' : 'internal'),
      evidence_refs: Array.isArray(context.evidence_refs) ? context.evidence_refs : [],
      expected_outcome: context.requested_terminal_outcome || context.deliverable || null,
      success_measure: context.success_measure || null,
      selection_reason: context.selection_reason || context.activation_condition || context.effect_basis || null,
      required_capabilities: Array.isArray(todo.requiredCapabilities) ? todo.requiredCapabilities : [],
      response_locale: context.response_locale || null,
      readiness: status,
    };
  }).sort((left, right) => left.recommendation_rank - right.recommendation_rank
    || new Date(right.checkpoint_at) - new Date(left.checkpoint_at));
}

function projectGrowthBrief(baselineArtifact, planArtifact) {
  if (!baselineArtifact && !planArtifact) return null;
  const baseline = baselineArtifact?.payload || {};
  const plan = planArtifact?.payload?.plan || {};
  const constraints = Array.isArray(plan.constraints) ? plan.constraints : [];
  const primary = constraints.find((item) => String(item?.id || '') === String(plan.primary_constraint_id || '')) || constraints[0] || null;
  const queue = Array.isArray(plan.operating_queue) ? plan.operating_queue : [];
  const recommendation = queue.find((item) => String(item?.id || '') === String(plan.stage?.queue_item_id || '')) || queue[0] || null;
  const evidenceRefs = Array.isArray(primary?.evidence_refs) ? primary.evidence_refs : [];
  const hypotheses = Array.isArray(plan.hypotheses) ? plan.hypotheses : [];
  const hypothesis = hypotheses.find((item) => (item.evidence_refs || []).some((ref) => evidenceRefs.includes(ref))) || hypotheses[0] || null;
  return {
    baseline_id: baselineArtifact?.id || null,
    plan_id: planArtifact?.id || null,
    current_position: baseline.company?.positioning || baseline.company?.offer || baseline.company?.description || null,
    primary_constraint: primary ? {
      id: primary.id || null,
      type: primary.type || null,
      statement: primary.statement || primary.description || null,
    } : null,
    evidence_refs: evidenceRefs,
    confidence: hypothesis?.confidence || null,
    material_unknowns: Array.isArray(primary?.unknowns) ? primary.unknowns : (Array.isArray(baseline.data_gaps) ? baseline.data_gaps : []),
    supporting_evidence: Array.isArray(primary?.known_facts) ? primary.known_facts : [],
    recommended_motion: recommendation ? {
      todo_source_id: recommendation.id || null,
      title: recommendation.title || null,
      objective: recommendation.objective || null,
      room: recommendation.room_tag || recommendation.kind || null,
      expected_outcome: recommendation.requested_terminal_outcome || recommendation.deliverable || null,
      success_measure: recommendation.success_measure || null,
      selection_reason: recommendation.effect_basis || null,
    } : null,
    captured_at: baselineArtifact?.createdAt || planArtifact?.createdAt || null,
  };
}

export function projectFirstLifeExperience({ runtime, firstLife, growthBrief, tasks, recognitionEvents, adminCheckin = null }) {
  if (!runtime) return null;
  const recognition = (recognitionEvents || []).map((row) => ({
    sequence: String(row.sequence),
    source_key: row.details?.source_key || row.title,
    status: row.details?.status || row.summary,
    facts: row.details?.facts ?? null,
    limitations: Array.isArray(row.details?.limitations) ? row.details.limitations : [],
    artifact_id: row.details?.artifact_id || row.evidenceRefs?.[0] || null,
    observed_at: row.createdAt?.toISOString?.() || row.createdAt,
  }));
  const opportunities = (firstLife?.items || []).map((item) => {
    const task = (tasks || []).find((candidate) => String(candidate.id) === String(item.todo_id));
    return { ...task, ...item, id: item.todo_id, todo_id: item.todo_id };
  });
  const recommendation = opportunities.find((item) => item.recommended)
    || opportunities.find((item) => item.todo_id === firstLife?.recommended_todo_id)
    || null;
  const planningEvidenceMissing = runtime.blockedReason === 'planning_evidence'
    || (firstLife?.status === 'NEEDS_ATTENTION' && !growthBrief && opportunities.length === 0);
  let phase = 'ACKNOWLEDGED';
  if (planningEvidenceMissing) phase = 'NEEDS_EVIDENCE';
  else if (adminCheckin?.status === 'WAITING_EVENT' && adminCheckin?.currentStageId === 'capture_admin_choice') phase = 'AWAITING_ADMIN_CHECKIN';
  else if (adminCheckin && !['COMPLETED', 'TERMINATED', 'NEEDS_INTERVENTION'].includes(String(adminCheckin.status))) phase = 'RECOGNIZING';
  else if (firstLife?.status === 'AWAITING_START' || firstLife?.status === 'REVIEW_LATER') phase = 'AWAITING_START';
  else if (firstLife) phase = 'OPERATING';
  else if (growthBrief) phase = 'PLANNING';
  else if (recognition.length) phase = 'RECOGNIZING';
  return {
    epoch: runtime.epoch,
    phase,
    recognition,
    growth_brief: growthBrief,
    opportunities,
    recommendation,
    can_start: phase === 'AWAITING_START' && recommendation?.status === 'PROPOSED',
    admin_checkin: adminCheckin ? {
      run_id: adminCheckin.id,
      status: adminCheckin.status,
      stage: adminCheckin.currentStageId,
      waiting_for: adminCheckin.waitingFor || null,
      terminal_state: adminCheckin.terminalState || null,
    } : null,
    waiting_reason: planningEvidenceMissing ? 'planning_evidence'
      : firstLife?.waiting_reason || null,
  };
}

export function createHqRuntimeRouteHandler({ prisma, requireSession, requirePrivilegedAgentAccess, parseBody, jsonResponse, wakeScheduler = null, runtimePlaybooks = null, logger = console }) {
  return async function handleHqRuntimeRoute(req, res, url) {
    const pathname = url.pathname;
    if (!pathname.startsWith('/v1/hq/')) return false;
    const current = await requireHqAccess({ req, res, requireSession, requirePrivilegedAgentAccess });
    if (!current) return true;
    const orgId = current.session.orgId;
    const userId = current.session.userId;

    try {
      if (pathname === '/v1/hq/runtime' && req.method === 'GET') {
        const runtime = await getHqRuntime({ prisma, orgId });
        const usage = await getHqUsage(prisma, orgId, runtime?.activatedAt || runtime?.createdAt || null);
        return jsonResponse(res, { runtime: asJsonRuntime(runtime), usage });
      }

      // GET /v1/hq/artifacts/:id — one org-scoped lookup for the Runtime
      // "Artifacts" panel's click-to-preview popup. Artifact refs collected
      // client-side (collectRuntimeArtifacts) come from two different rows
      // depending on stage: RuntimePlaybookArtifact (per-checkpoint outputs,
      // e.g. planning evidence) or SourceArtifact (company_baseline/
      // growth_plan). Try both rather than inventing a third unified table.
      const artifactMatch = pathname.match(/^\/v1\/hq\/artifacts\/([^/]+)$/);
      if (artifactMatch && req.method === 'GET') {
        const id = artifactMatch[1];
        // Every ref the FE ever holds for a RuntimePlaybookArtifact is the
        // string business key (`artifactId`, e.g. "artifact:research_decision:1"
        // — see publicArtifact() in postgres-store.js), never the row's own
        // UUID `id`. Matching against `id` too (as an earlier version of this
        // route did) throws a Prisma validation error on a non-UUID string —
        // silently swallowed by the .catch below into a false "not found".
        // Confirmed live 2026-08-18: a real research_decision popup showed
        // "Could not load this artifact" because of exactly this.
        const playbookArtifact = await prisma.runtimePlaybookArtifact.findFirst({
          where: { orgId, artifactId: id },
          orderBy: { createdAt: 'desc' },
        }).catch(() => null);
        if (playbookArtifact) {
          return jsonResponse(res, {
            id: playbookArtifact.artifactId,
            key: playbookArtifact.artifactKey,
            title: playbookArtifact.artifactKey?.replaceAll('_', ' ') || 'Artifact',
            kind: 'json',
            content: JSON.stringify(playbookArtifact.data ?? {}, null, 2),
            data: playbookArtifact.data ?? {},
            createdAt: playbookArtifact.createdAt,
          });
        }
        // SourceArtifact IS keyed by a real UUID `id` (baseline_id/plan_id
        // collected client-side genuinely are SourceArtifact.id values) —
        // this branch is correct as-is, unlike the one above.
        const sourceArtifact = await prisma.sourceArtifact.findFirst({ where: { orgId, id } }).catch(() => null);
        if (sourceArtifact) {
          return jsonResponse(res, {
            id: sourceArtifact.id,
            key: sourceArtifact.sourcePlatform,
            title: String(sourceArtifact.sourcePlatform || 'Artifact').replaceAll('_', ' '),
            kind: 'json',
            content: JSON.stringify(sourceArtifact.payload ?? {}, null, 2),
            createdAt: sourceArtifact.createdAt,
          });
        }
        return jsonResponse(res, { error: 'artifact_not_found' }, 404);
      }

      if (pathname === '/v1/hq/authority-policy' && req.method === 'PATCH') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const body = await parseBody(req).catch(() => ({}));
        const legacyOverrides = Object.fromEntries(Object.entries(body)
          .filter(([key, value]) => key.startsWith('outbound_') && value != null)
          .map(([key, value]) => [key, String(value || '').trim().toLowerCase()]));
        const requestedOverrides = body.gate_overrides && typeof body.gate_overrides === 'object' && !Array.isArray(body.gate_overrides)
          ? body.gate_overrides : {};
        const externalDefault = body.external_default == null ? null : String(body.external_default).trim().toLowerCase();
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        const manualOnlyPolicyKeys = new Set((service?.registry?.definitions?.() || [])
          .flatMap((definition) => definition.stages || [])
          .filter((stage) => stage.authority_policy_mode === 'manual_only' && stage.authority_policy_key)
          .map((stage) => stage.authority_policy_key));
        const combinedOverrides = { ...legacyOverrides, ...requestedOverrides };
        const requested = normalizeAuthorityPolicy({
          ...(runtime.authorityPolicy || {}),
          ...(externalDefault ? { external_default: externalDefault } : {}),
          gate_overrides: {
            ...(runtime.authorityPolicy?.gate_overrides || {}),
            ...legacyOverrides,
            ...requestedOverrides,
          },
        });
        if ((!externalDefault && !Object.keys(legacyOverrides).length && !Object.keys(requestedOverrides).length)
            || (externalDefault && !['manual', 'auto'].includes(externalDefault))
            || Object.values(combinedOverrides).some((value) => !['manual', 'auto'].includes(value))
            || Object.entries(combinedOverrides).some(([key, value]) => manualOnlyPolicyKeys.has(key) && value === 'auto')) {
          return jsonResponse(res, { error: 'hq_runtime_outbound_authority_invalid' }, 400);
        }
        if (JSON.stringify(normalizeAuthorityPolicy(runtime.authorityPolicy || {})) !== JSON.stringify(requested)) {
          await prisma.hqRuntime.update({
            where: { id: runtime.id },
            data: { authorityPolicy: requested, version: { increment: 1 } },
          });
          await appendHqEvent({
            prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
            eventType: 'verification',
            title: 'External authority policy updated',
            summary: 'The organization policy now governs future exact playbook gates. No pending or future action was granted by this policy update.',
            details: { actor: userId, external_default: requested.external_default, gate_overrides: requested.gate_overrides },
          });
        }
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })) });
      }

      if (pathname === '/v1/hq/activate' && req.method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const objective = String(body.objective || await findDefaultObjective(prisma, orgId)).trim().slice(0, 5000);
        if (!objective) return jsonResponse(res, { error: 'hq_runtime_objective_required' }, 400);
        let runtime = await ensureHqRuntime({ prisma, orgId, userId, objective, authorityPolicy: body.authority_policy || {} });
        if (runtime.state === 'INACTIVE') {
          runtime = await transitionHqRuntime({
            prisma, runtimeId: runtime.id, orgId, from: 'INACTIVE', to: 'OBSERVING',
            data: { activatedAt: new Date() },
          });
          await appendHqEvent({
            prisma, runtimeId: runtime.id, orgId, eventType: 'wake',
            title: 'Company operation activated',
            summary: 'HQ is establishing current company state before choosing its first bounded action.',
          });
        }
        const schedule = runtime.state === 'PAUSED' ? null : await requestWake({
          prisma, runtime, triggerType: 'activation', key: `activation:${runtime.id}`,
        });
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })), schedule }, 201);
      }

      if (pathname === '/v1/hq/launch' && req.method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const instructionBody = String(body.instruction || '').trim().slice(0, 5000);
        if (!instructionBody) return jsonResponse(res, { error: 'hq_instruction_required' }, 400);
        const existingRuntime = await getHqRuntime({ prisma, orgId });
        const freshStart = !existingRuntime || existingRuntime.state === 'INACTIVE';
        const objective = String(freshStart
          ? FIRST_LIFE_OBJECTIVE
          : body.objective || await findDefaultObjective(prisma, orgId)).trim().slice(0, 5000);
        if (!objective) return jsonResponse(res, { error: 'hq_runtime_objective_required' }, 400);

        let runtime = await ensureHqRuntime({
          prisma, orgId, userId, objective,
          authorityPolicy: body.authority_policy || { internal_autonomy: true },
        });
        if (runtime.state === 'INACTIVE') {
          runtime = await transitionHqRuntime({
            prisma, runtimeId: runtime.id, orgId, from: 'INACTIVE', to: 'OBSERVING',
            data: { activatedAt: new Date() },
          });
        } else if (runtime.state === 'PAUSED') {
          runtime = await transitionHqRuntime({
            prisma, runtimeId: runtime.id, orgId, from: 'PAUSED', to: 'OBSERVING',
            data: { pauseReason: null },
          });
        }

        const instruction = await prisma.hqInstruction.create({
          data: {
            runtimeId: runtime.id, orgId, userId, body: instructionBody,
            interpreted: {
              source: 'runtime_invitation',
              focuses: Array.isArray(body.focuses) ? body.focuses.map(String).slice(0, 12) : [],
              execution_mode: body.execution_mode === 'single_outcome' ? 'single_outcome' : 'operating_plan',
            },
          },
        });
        const schedule = await requestWake({
          prisma, runtime, triggerType: 'user_first_activation',
          payload: { instruction_id: instruction.id, source: 'runtime_invitation', fresh_start: freshStart },
          key: `runtime_launch:${instruction.id}`,
        });
        const activationEvent = await appendHqEvent({
          prisma,
          runtimeId: runtime.id,
          orgId,
          runtimeEpoch: runtime.epoch,
          eventType: 'activation_received',
          title: 'Runtime activation received',
          summary: 'The operating instruction and wake request are durable. Runtime will now inspect the persisted company evidence.',
          details: {
            instruction_id: instruction.id,
            schedule_id: schedule?.id || null,
            trigger_type: 'user_first_activation',
            runtime_epoch: runtime.epoch,
          },
        });
        return jsonResponse(res, {
          runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })), instruction, schedule,
          activation_event: asJsonEvent(activationEvent),
        }, 201);
      }

      if (pathname === '/v1/hq/pause' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        if (runtime.state !== 'PAUSED') {
          if (!ACTIVE_STATES.has(runtime.state)) return jsonResponse(res, { error: 'hq_runtime_not_active' }, 409);
          const body = await parseBody(req).catch(() => ({}));
          await transitionHqRuntime({ prisma, runtimeId: runtime.id, orgId, from: runtime.state, to: 'PAUSED', data: { pauseReason: String(body.reason || 'Paused by user').slice(0, 1000) } });
          await appendHqEvent({ prisma, runtimeId: runtime.id, orgId, eventType: 'sleep', title: 'HQ paused', summary: 'No new HQ cycles or external operations will begin until the runtime is resumed.' });
        }
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })) });
      }

      if (pathname === '/v1/hq/resume' && req.method === 'POST') {
        let runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        if (runtime.state === 'PAUSED') {
          runtime = await transitionHqRuntime({ prisma, runtimeId: runtime.id, orgId, from: 'PAUSED', to: 'OBSERVING', data: { pauseReason: null } });
          await appendHqEvent({ prisma, runtimeId: runtime.id, orgId, eventType: 'wake', title: 'HQ resumed', summary: 'HQ will refresh material state and continue from its last durable checkpoint.' });
        }
        const schedule = await requestWake({ prisma, runtime, triggerType: 'user_resume', key: `resume:${runtime.version}` });
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })), schedule });
      }

      if (pathname === '/v1/hq/wake' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        if (runtime.state === 'PAUSED') return jsonResponse(res, { error: 'hq_runtime_paused' }, 409);
        const activeCycle = await prisma.hqCycle.findFirst({
          where: { orgId, runtimeEpoch: runtime.epoch, status: { in: ['QUEUED', 'RUNNING'] } }, orderBy: { createdAt: 'desc' },
        });
        if (activeCycle) return jsonResponse(res, { runtime: asJsonRuntime(runtime), cycle: activeCycle, already_running: true });
        const activeWorkOrder = await prisma.hyperWorkOrder.findFirst({
          where: { orgId, runtimeEpoch: runtime.epoch, hqCycleId: { not: null }, status: { in: ['queued', 'running', 'processing'] } },
          select: { id: true, title: true, status: true },
        });
        if (activeWorkOrder) {
          return jsonResponse(res, { runtime: asJsonRuntime(runtime), work_order: activeWorkOrder, already_operating: true });
        }
        const body = await parseBody(req).catch(() => ({}));
        const schedule = await requestWake({
          prisma, runtime, triggerType: 'user_wake', payload: body.payload || {},
          key: String(body.idempotency_key || `user_wake:${Date.now()}`).slice(0, 160),
        });
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })), schedule }, 202);
      }

      if (pathname === '/v1/hq/restart' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        await prisma.runtimePlaybookRun?.deleteMany?.({ where: { orgId } }).catch?.(() => {});
        const reset = await resetHqForCompanyReplacement({ prisma, orgId });
        return jsonResponse(res, {
          runtime: asJsonRuntime(reset),
          reset: true,
          next: 'runtime_invitation',
        });
      }

      if (pathname === '/v1/hq/objective' && req.method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const objective = String(body.objective || '').trim().slice(0, 5000);
        if (!objective) return jsonResponse(res, { error: 'hq_runtime_objective_required' }, 400);
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const updated = await prisma.hqRuntime.updateMany({ where: { id: runtime.id, orgId }, data: { objective, version: { increment: 1 } } });
        if (updated.count !== 1) return jsonResponse(res, { error: 'hq_runtime_update_conflict' }, 409);
        await appendHqEvent({ prisma, runtimeId: runtime.id, orgId, eventType: 'decision', title: 'Company objective updated', summary: objective, details: { actor: 'user' } });
        return jsonResponse(res, { runtime: asJsonRuntime(await getHqRuntime({ prisma, orgId })) });
      }

      if (pathname === '/v1/hq/events' && req.method === 'GET') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { events: [], next: null });
        const after = BigInt(url.searchParams.get('after') || '0');
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 100)));
        const events = await prisma.hqRuntimeEvent.findMany({
          where: { runtimeId: runtime.id, orgId, sequence: { gt: after }, visibility: 'USER' },
          orderBy: { sequence: 'asc' }, take: limit,
        });
        return jsonResponse(res, { events: events.map(asJsonEvent), next: events.length ? String(events.at(-1).sequence) : String(after) });
      }

      if (pathname === '/v1/hq/events/stream' && req.method === 'GET') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        let cursor = eventCursor(url.searchParams.get('after'), req.headers['last-event-id']);
        const connectedAt = Date.now();
        const reconnected = cursor > 0n;
        let closed = false;
        let writing = false;
        let writeQueued = false;
        let unsubscribe = async () => {};
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no' });
        res.flushHeaders?.();
        res.write('retry: 3000\n\n');
        const writeAvailable = async () => {
          if (closed || writing) return;
          writing = true;
          try {
            const rows = await prisma.hqRuntimeEvent.findMany({
              where: { runtimeId: runtime.id, orgId, sequence: { gt: cursor }, visibility: 'USER' },
              orderBy: { sequence: 'asc' }, take: 100,
            });
            for (const row of rows) {
              cursor = row.sequence;
              res.write(`id: ${row.sequence}\nevent: hq_event\ndata: ${JSON.stringify(asJsonEvent(row))}\n\n`);
            }
          } finally {
            writing = false;
          }
        };
        const queueWrite = () => {
          if (closed || writeQueued) return;
          writeQueued = true;
          setImmediate(() => {
            writeQueued = false;
            if (writing) {
              queueWrite();
              return;
            }
            writeAvailable().catch((error) => logger.warn('[hq-runtime] event stream delivery query failed:', {
              runtime_id: runtime.id, org_id: orgId, cursor: String(cursor), message: error.message,
            }));
          });
        };
        unsubscribe = await subscribeHqRuntimeEvents(runtime.id, (notice) => {
          if (notice?.transient === true && notice?.event) {
            if (notice.org_id && String(notice.org_id) !== String(orgId)) return;
            res.write(`event: hq_stream_delta\ndata: ${JSON.stringify(notice.event)}\n\n`);
            return;
          }
          if (notice?.event?.visibility && notice.event.visibility !== 'USER') return;
          const sequence = eventCursor(notice?.sequence);
          if (sequence <= cursor) return;
          if (writing || sequence !== cursor + 1n || !notice?.event) {
            queueWrite();
            return;
          }
          cursor = sequence;
          res.write(`id: ${sequence}\nevent: hq_event\ndata: ${JSON.stringify(notice.event)}\n\n`);
        });
        // Subscribe before catch-up so an event committed during hydration cannot
        // fall between the initial query and the live notification boundary.
        await writeAvailable();
        const heartbeat = setInterval(() => { if (!closed) res.write(': keepalive\n\n'); }, 15000);
        const close = (reason, error = null) => {
          if (closed) return;
          closed = true;
          clearInterval(heartbeat);
          unsubscribe().catch(() => {});
          recordRuntimeMetric(prisma, {
            orgId,
            metric: 'sse_connection_duration',
            value: Date.now() - connectedAt,
            unit: 'ms',
            source: 'hq-runtime-sse',
            metadata: { reason, reconnected, final_cursor: String(cursor) },
          });
          const expected = ['ABORT_ERR', 'ECONNRESET'].includes(String(error?.code || '').toUpperCase())
            || ['AbortError'].includes(String(error?.name || ''))
            || /aborted|socket hang up/i.test(String(error?.message || ''));
          if (error && !expected) logger.warn('[hq-runtime] event stream closed with an error:', {
            runtime_id: runtime.id, org_id: orgId, cursor: String(cursor), reason, message: error.message,
          });
        };
        req.on('close', () => close('client_closed'));
        req.on('error', (error) => close('request_error', error));
        res.on('error', (error) => close('response_error', error));
        recordRuntimeMetric(prisma, {
          orgId,
          metric: reconnected ? 'sse_reconnect' : 'sse_connect',
          value: 1,
          unit: 'count',
          source: 'hq-runtime-sse',
          metadata: { cursor: String(cursor) },
        });
        return true;
      }

      if (pathname === '/v1/hq/work' && req.method === 'GET') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { work_orders: [], schedules: [] });
        await reconcileRuntimeCapabilities({ prisma, runtime, wakeScheduler });
        const playbookService = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        const [workOrders, schedules, todos, capabilityRequests, instructions, playbookRuns, baselineArtifact, planArtifacts, recognitionEvents] = await Promise.all([
          prisma.hyperWorkOrder.findMany({ where: { orgId, runtimeEpoch: runtime.epoch, hqCycleId: { not: null } }, orderBy: { createdAt: 'desc' }, take: 50 }),
          prisma.hqSchedule.findMany({ where: { orgId, runtimeEpoch: runtime.epoch, status: { in: ['PENDING', 'LEASED'] } }, orderBy: { dueAt: 'asc' }, take: 50 }),
          prisma.hqTodo.findMany({ where: { orgId, runtimeId: runtime.id, status: { notIn: ['CANCELLED'] } }, orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }], take: 50 }),
          prisma.hqCapabilityRequest.findMany({ where: { orgId, status: 'REQUIRED' }, orderBy: { createdAt: 'asc' }, take: 20 }),
          prisma.hqInstruction.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 20 }),
          prisma.runtimePlaybookRun?.findMany ? prisma.runtimePlaybookRun.findMany({
            where: { orgId }, orderBy: { updatedAt: 'desc' }, take: 50,
            include: {
              artifacts: { where: { status: { not: 'SUPERSEDED' } }, orderBy: { createdAt: 'asc' } },
              checkpoints: { orderBy: { sequence: 'desc' }, take: 1 },
              authorities: { orderBy: { grantedAt: 'asc' } },
            },
          }).catch(() => []) : Promise.resolve([]),
          prisma.sourceArtifact.findFirst({ where: { orgId, sourcePlatform: 'growth_baseline', artifactType: 'api_response' }, orderBy: { createdAt: 'desc' } }),
          prisma.sourceArtifact.findMany({ where: { orgId, sourcePlatform: 'growth_plan', artifactType: 'api_response' }, orderBy: { createdAt: 'desc' }, take: 12 }),
          prisma.hqRuntimeEvent.findMany({
            where: { orgId, runtimeId: runtime.id, eventType: 'baseline_observation' },
            orderBy: { sequence: 'asc' },
            take: 50,
          }),
        ]);
        const todoById = new Map(todos.map((todo) => [todo.id, todo]));
        const outreachLeadRefs = [...new Set(playbookRuns.flatMap((run) => run.artifacts)
          .filter((artifact) => artifact.artifactKey === 'lead_record')
          .map((artifact) => String(artifact.data?.persistence_ref || '')).filter(Boolean))];
        const outreachTargets = outreachLeadRefs.length ? await prisma.outreachTarget.findMany({
          where: { id: { in: outreachLeadRefs }, campaign: { orgId } },
          select: { id: true, company: true, email: true, phone: true, inputContext: true },
        }).catch(() => []) : [];
        const outreachCallProposals = projectOutreachCallProposals({
          playbookRuns, outreachTargets, todos, runtimeId: runtime.id, runtimeEpoch: runtime.epoch,
        });
        const campaignsByRun = new Map((playbookRuns.length ? await prisma.campaign.findMany({
          where: { orgId, sourceType: 'runtime_playbook', sourceId: { in: playbookRuns.map((run) => run.id) } },
          select: {
            id: true, sourceId: true, name: true, status: true, requestedChannels: true, currentPlanVersionId: true,
            actions: {
              orderBy: { position: 'asc' },
              select: {
                id: true, planVersionId: true, channel: true, actionType: true, position: true, status: true,
                scheduledAt: true, payload: true, rationale: true, successMetric: true,
                assets: {
                  select: {
                    id: true, status: true, storageKey: true, contentType: true, width: true, height: true,
                    metadata: true, deletedAt: true,
                  },
                },
              },
            },
          },
        }) : []).map((campaign) => [campaign.sourceId, campaign]));
        const projectPreparedBatch = (runId) => {
          const run = playbookRuns.find((candidate) => String(candidate.id) === String(runId));
          if (!run) return null;
          const messages = run.artifacts.filter((artifact) => artifact.artifactKey === 'message_record').map((artifact) => ({
            id: artifact.artifactId,
            lead_ref: artifact.data?.lead_ref || null,
            to: artifact.data?.recipient || null,
            subject: artifact.data?.subject || null,
            body: artifact.data?.body || null,
          }));
          const calls = run.artifacts.filter((artifact) => artifact.artifactKey === 'lead_record' && artifact.data?.phone).map((artifact) => ({
            id: artifact.artifactId,
            target_ref: artifact.id,
            prospect: artifact.data?.company || artifact.data?.organization || null,
            phone: artifact.data.phone,
            goal: artifact.data?.outreach_angle || null,
          }));
          return messages.length || calls.length ? { run_id: run.id, messages, calls } : null;
        };
        const projectedCapabilityRequests = capabilityRequests.map((request) => {
          const todo = todoById.get(String(request.todoId || ''));
          const runId = String(todo?.context?.runtime_capability_run_id || '');
          return {
            ...request,
            connector_provider: getHyperagentsRuntimeConnectorProvider(),
            connector_toolkit: getHyperagentsRuntimeConnectorProvider() === 'composio'
              ? toComposioToolkit(request.capability || request.provider) : null,
            campaign: projectCampaignAuthorityPreview(campaignsByRun.get(runId) || null),
            prepared_batch: projectPreparedBatch(runId),
            deferred: String(todo?.context?.deferred_capability_request_id || '') === String(request.id),
          };
        });
        const playbookProjectionWarnings = [];
        const playbookInputs = playbookRuns.filter((run) => run.status === 'WAITING_EVENT'
          && (run.waitingFor?.types || [run.waitingFor?.type]).includes('input.provided')).map((run) => {
          const request = [...run.artifacts].reverse().find((artifact) => artifact.artifactKey === 'input_request');
          if (!request) return null;
          return {
            run_id: run.id,
            input_key: request.data?.input_key,
            label: request.data?.label || request.data?.input_key,
            description: request.data?.description || '',
            value_type: request.data?.value_type || 'string',
          };
        }).filter((request) => request?.input_key);
        const playbookApprovals = playbookRuns.filter((run) => run.status === 'WAITING_AUTHORITY').map((run) => {
          let playbook;
          try {
            playbook = playbookService?.registry?.get(run.playbookId, run.playbookVersion, { scopeKey: run.scopeKey });
          } catch (error) {
            playbookProjectionWarnings.push({
              run_id: run.id,
              playbook_id: run.playbookId,
              playbook_version: run.playbookVersion,
              code: 'playbook_definition_unavailable',
            });
            return null;
          }
          const stage = playbook?.stages?.find((candidate) => candidate.id === run.currentStageId);
          if (!stage?.authority_gate || !stage?.authority_policy_key) return null;
          const messages = run.artifacts.filter((artifact) => artifact.artifactKey === 'message_record').map((artifact) => ({
            id: artifact.artifactId,
            lead_ref: artifact.data?.lead_ref || null,
            to: artifact.data?.recipient || null,
            subject: artifact.data?.subject || null,
            body: artifact.data?.body || null,
          }));
          const calls = run.artifacts.filter((artifact) => artifact.artifactKey === 'call_contract').map((artifact) => ({
            id: artifact.artifactId,
            target_ref: artifact.data?.target_ref || null,
            prospect: artifact.data?.prospect || null,
            phone: artifact.data?.phone || null,
            goal: artifact.data?.goal || null,
            opener: artifact.data?.opener || null,
            strategy: artifact.data?.strategy || null,
            language: artifact.data?.language || null,
            voice_style: artifact.data?.voice_style || null,
          }));
          const todo = todoById.get(String(run.trigger?.todo_id || ''));
          const campaign = campaignsByRun.get(run.id) || null;
          return {
            run_id: run.id,
            todo_id: todo?.id || null,
            title: todo?.title || playbook?.name || 'External messages are ready',
            gate: stage.authority_gate,
            policy_key: stage.authority_policy_key,
            preference: stage.authority_policy_mode === 'manual_only'
              ? 'manual' : resolveAuthorityPreference(runtime.authorityPolicy, stage.authority_policy_key),
            manual_only: stage.authority_policy_mode === 'manual_only',
            kind: 'external_action',
            messages,
            calls,
            campaign: projectCampaignAuthorityPreview(campaign),
          };
        }).filter(Boolean);
        const activationSprint = await projectCurrentActivationSprint({ prisma, orgId });
        const firstLife = activationSprint?.policy?.id === 'runtime.first-life-policy' ? activationSprint : null;
        const currentPlanArtifact = planArtifacts.find((artifact) => {
          const baselineId = artifact.payload?.plan?.baseline_ref?.resource_id || artifact.metadata?.baseline_id || null;
          return !baselineArtifact?.id || baselineId === baselineArtifact.id;
        }) || null;
        const playbookOwners = new Map();
        for (const run of playbookRuns) {
          try {
            const definition = playbookService?.registry?.get(run.playbookId, run.playbookVersion, { scopeKey: run.scopeKey });
            const owner = String(definition?.metadata?.owner_room_tag || '').trim().toLowerCase();
            if (owner) playbookOwners.set(`${run.playbookId}@${run.playbookVersion}`, owner);
          } catch { /* Historical unavailable definitions are reported separately below. */ }
        }
        const agentRuntimeTasks = projectAgentRuntimeTasks({ todos, playbookRuns, playbookOwners });
        const campaignPreviews = projectRuntimeCampaignPreviews({
          playbookRuns, campaignsByRun, runtimeId: runtime.id, runtimeEpoch: runtime.epoch,
        });
        const growthBrief = projectGrowthBrief(baselineArtifact, currentPlanArtifact);
        const adminCheckin = playbookRuns.find((run) => run.playbookId === 'operations.browser-admin-checkin-to-status'
          && run.trigger?.first_life_admin_checkin === true
          && String(run.trigger?.runtime_epoch || '') === String(runtime.epoch)) || null;
        const firstLifeExperience = projectFirstLifeExperience({
          runtime, firstLife, growthBrief, tasks: agentRuntimeTasks, recognitionEvents, adminCheckin,
        });
        return jsonResponse(res, {
          work_orders: workOrders, schedules, todos, capability_requests: projectedCapabilityRequests, instructions,
          agent_runtime_tasks: agentRuntimeTasks,
          runtime_queue: agentRuntimeTasks,
          growth_brief: growthBrief,
          first_life_experience: firstLifeExperience,
          outreach_call_proposals: outreachCallProposals,
          campaign_previews: campaignPreviews,
          playbook_approvals: playbookApprovals, playbook_runs: playbookRuns,
          playbook_inputs: playbookInputs,
          playbook_snapshots: playbookRuns.map((run) => projectRuntimePlaybookSnapshot(run)),
          playbook_projection_warnings: playbookProjectionWarnings,
          first_life: firstLife, activation_sprint: activationSprint,
        });
      }

      const outreachCallsMatch = pathname.match(/^\/v1\/hq\/outreach\/runs\/([0-9a-f-]{36})\/calls$/i);
      if (outreachCallsMatch && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const sourceRun = await prisma.runtimePlaybookRun.findFirst({
          where: { id: outreachCallsMatch[1], orgId, playbookId: 'outreach.prospect-to-conversation' },
          include: { artifacts: { where: { status: { not: 'SUPERSEDED' } }, orderBy: { createdAt: 'asc' } } },
        });
        if (!sourceRun || String(sourceRun.trigger?.runtime_id || '') !== String(runtime.id)
          || String(sourceRun.trigger?.runtime_epoch || '') !== String(runtime.epoch)) {
          return jsonResponse(res, { error: 'runtime_outreach_source_unavailable' }, 404);
        }
        const leadRefs = sourceRun.artifacts.filter((artifact) => artifact.artifactKey === 'lead_record')
          .map((artifact) => String(artifact.data?.persistence_ref || '')).filter(Boolean);
        const [outreachTargets, currentTodos] = await Promise.all([
          leadRefs.length ? prisma.outreachTarget.findMany({
            where: { id: { in: leadRefs }, campaign: { orgId } },
            select: { id: true, company: true, email: true, phone: true, inputContext: true },
          }) : [],
          prisma.hqTodo.findMany({ where: { runtimeId: runtime.id, orgId } }),
        ]);
        const proposal = projectOutreachCallProposals({
          playbookRuns: [sourceRun], outreachTargets, todos: [], runtimeId: runtime.id, runtimeEpoch: runtime.epoch,
        })[0];
        if (!proposal) return jsonResponse(res, { error: 'runtime_outreach_no_verified_call_targets' }, 409);
        let todo = currentTodos.find((candidate) => String(candidate.context?.source_outreach_run_id || '') === sourceRun.id);
        if (!todo) {
          const sourceTodo = currentTodos.find((candidate) => String(candidate.id) === String(sourceRun.trigger?.todo_id || ''));
          todo = await prisma.hqTodo.create({ data: {
            runtimeId: runtime.id, orgId, instructionId: sourceTodo?.instructionId || null,
            title: proposal.title,
            objective: `Call ${proposal.targets.length} verified outreach prospect${proposal.targets.length === 1 ? '' : 's'} sequentially with TARA. Analyze each completed transcript and retained lead learning before preparing the next call.`,
            kind: 'runtime_task', status: 'PROPOSED',
            priority: Number(sourceTodo?.priority || 100) + 1,
            position: Number(sourceTodo?.position || 0) + 1,
            requiredCapabilities: [],
            context: {
              proposal_origin: 'user_instruction',
              runtime_epoch: runtime.epoch,
              source_outreach_run_id: sourceRun.id,
              source_outreach_todo_id: sourceTodo?.id || null,
              source_instruction: proposal.title,
              requested_action: 'place_sequential_voice_calls',
              requested_terminal_outcome: 'cohort_completed',
              expected_outcome: 'cohort_completed',
              effect_class: 'external', external_action_requested: true,
              exact_targets: proposal.targets,
              evidence_refs: proposal.targets.flatMap((target) => target.source_refs || []),
              acceptance_criteria: ['Every selected call reaches a durable analyzed outcome before the next call begins.'],
            },
          } });
        }
        const activation = await activateEligibleFirstLifeWork({
          prisma, runtime, expansionTrigger: 'user_instruction', proposalOrigin: 'user_instruction',
        });
        await appendHqEvent({
          prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
          eventType: 'todo_created', title: 'TARA outreach sequence retained',
          summary: activation.promoted.some((item) => item.id === todo.id)
            ? 'Runtime will prepare the verified calls sequentially. No call is placed before its exact authority gate.'
            : 'The verified call sequence is queued behind the active external lifecycle and will retain the same targets and notes.',
          details: { todo_id: todo.id, source_run_id: sourceRun.id, target_count: proposal.targets.length, promoted: activation.promoted },
        });
        if (activation.promoted.length) await requestWake({
          prisma, runtime, triggerType: 'queue_advance',
          payload: { promoted_todo_ids: activation.promoted.map((item) => item.id) },
          key: `outreach-calls:${sourceRun.id}`,
        });
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { ok: true, todo_id: todo.id, target_count: proposal.targets.length, promoted: activation.promoted }, 202);
      }

      const capabilityDeferMatch = pathname.match(/^\/v1\/hq\/capability-requests\/([^/]+)\/defer$/);
      if (capabilityDeferMatch && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const requestId = decodeURIComponent(capabilityDeferMatch[1]);
        const capabilityRequest = await prisma.hqCapabilityRequest.findFirst({
          where: { id: requestId, orgId, status: 'REQUIRED' },
        });
        if (!capabilityRequest?.todoId) return jsonResponse(res, { error: 'capability_request_not_found' }, 404);
        const todo = await prisma.hqTodo.findFirst({ where: { id: capabilityRequest.todoId, orgId } });
        if (!todo) return jsonResponse(res, { error: 'capability_todo_not_found' }, 404);
        await prisma.hqTodo.update({ where: { id: todo.id }, data: {
          context: {
            ...(todo.context || {}), execution_slot_released: true,
            execution_slot_release_trigger: 'capability_deferred',
            deferred_capability_request_id: capabilityRequest.id,
          },
        } });
        const activation = await activateEligibleFirstLifeWork({
          prisma, runtime, expansionTrigger: 'verified_preparation_checkpoint',
        });
        await appendHqEvent({
          prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
          eventType: 'decision', title: 'Prepared work retained for later connection',
          summary: 'The prepared artifacts remain attached to this lifecycle. Runtime may prepare the next eligible task and will resume this one when its capability becomes available.',
          details: { capability_request_id: capabilityRequest.id, todo_id: todo.id, promoted: activation.promoted },
        });
        if (activation.promoted.length) await requestWake({
          prisma, runtime, triggerType: 'queue_advance',
          payload: { promoted_todo_ids: activation.promoted.map((item) => item.id) },
          key: `capability-deferred:${capabilityRequest.id}`,
        });
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { ok: true, retained: true, promoted: activation.promoted }, 202);
      }

      if ((pathname === '/v1/hq/first-life/current' || pathname === '/v1/hq/activation-sprints/current') && req.method === 'GET') {
        const sprint = await projectCurrentActivationSprint({ prisma, orgId });
        const firstLife = sprint?.policy?.id === 'runtime.first-life-policy' ? sprint : null;
        return jsonResponse(res, { first_life: firstLife, sprint });
      }

      if (pathname === '/v1/hq/first-life/admin-checkin' && req.method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const decision = String(body.decision || '').trim().toLowerCase();
        if (!['started', 'skipped', 'completed'].includes(decision)) return jsonResponse(res, { error: 'admin_checkin_decision_invalid' }, 400);
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const rows = await prisma.runtimePlaybookRun.findMany({ where: { orgId, playbookId: 'operations.browser-admin-checkin-to-status' }, orderBy: { updatedAt: 'desc' }, take: 12 });
        const run = rows.find((row) => row.trigger?.first_life_admin_checkin === true && String(row.trigger?.runtime_epoch || '') === String(runtime.epoch)) || null;
        if (!run) return jsonResponse(res, { error: 'admin_checkin_not_available' }, 409);
        const sessionId = String(body.session_id || '').trim().slice(0, 256) || null;
        if (['started', 'completed'].includes(decision) && !sessionId) return jsonResponse(res, { error: 'admin_checkin_session_required' }, 400);
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        if (!service) return jsonResponse(res, { error: 'runtime_playbook_service_unavailable' }, 503);
        // The analyze_current_status stage is a Room review whose objective is to analyze
        // "the exact browser-session transcript" and whose predicates demand a SOURCE-BACKED
        // user_current_status artifact. The event previously carried only a session_id, so
        // the Room was asked to analyze a conversation it never received — it returned zero
        // artifacts every attempt and the lifecycle looped on
        // `has_min_count:user_current_status:0`. Attach the real transcript here so the Room
        // has the actual source it is required to ground on. Best-effort: a missing transcript
        // must never break the decision call; the stage then fails honestly on its own terms.
        let transcript = '';
        if (decision === 'completed' && sessionId) {
          try {
            const call = await prisma.taraCall.findUnique({
              where: { orgId_sessionId: { orgId, sessionId } }, select: { id: true },
            });
            if (call?.id) {
              const turns = await prisma.taraTurn.findMany({
                where: { callId: call.id }, orderBy: { seq: 'asc' },
                select: { userText: true, agentText: true },
              });
              transcript = turns
                .map((t) => `Administrator: ${t.userText || ''}\nRuntime: ${t.agentText || ''}`)
                .join('\n').trim().slice(0, 12000);
            }
          } catch (error) {
            console.warn('[hq-runtime] admin check-in transcript unavailable:', error.message);
          }
        }
        const resumed = await service.resumeEvent(run.id, orgId, {
          id: `admin-checkin:${run.id}:${decision}:${sessionId || 'none'}`,
          type: `admin_checkin.${decision}`,
          data: {
            session_id: sessionId, correlation_ref: sessionId, runtime_epoch: runtime.epoch,
            ...(transcript ? { transcript, transcript_source: `tara_session:${sessionId}` } : {}),
          },
        });
        await appendHqEvent({
          prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
          eventType: decision === 'skipped' ? 'decision' : 'observation',
          title: decision === 'skipped' ? 'Internal check-in skipped' : decision === 'started' ? 'Internal check-in started' : 'Internal check-in received',
          summary: decision === 'skipped' ? 'Runtime retained the explicit skip and will form the first plan from the baseline evidence.' : decision === 'started' ? 'Runtime will wait for the exact browser conversation before it forms the first plan.' : 'Runtime received the completed browser conversation and is preparing the source-backed internal status record.',
          details: { admin_checkin_run_id: run.id, decision, session_id: sessionId },
        });
        // SKIP MUST NEVER BLOCK. The run parks in WAITING_EVENT on the NEXT stage while
        // waiting for admin_checkin.completed (correlated by session_id). A `skipped`
        // event does not match that wait, so resumeEvent silently ignored it and the
        // whole Runtime stalled — observed live: status WAITING_EVENT, stage
        // analyze_current_status, planning never started. A skip is a terminal user
        // decision, not an event the lifecycle may decline: force the run terminal so
        // native-engine's adminCheckinDisposition() sees a settled run and proceeds to
        // the first operating plan from baseline evidence.
        if (decision === 'skipped') {
          const after = await prisma.runtimePlaybookRun.findFirst({ where: { id: run.id, orgId }, select: { status: true } }).catch(() => null);
          if (after && !['COMPLETED', 'TERMINATED'].includes(String(after.status))) {
            await prisma.runtimePlaybookRun.updateMany({
              where: { id: run.id, orgId },
              data: { status: 'TERMINATED', terminalState: 'admin_checkin_skipped', waitingFor: null, completedAt: new Date() },
            }).catch((error) => console.warn('[hq-runtime] admin check-in skip force-terminate failed:', error.message));
          }
        }
        if (['skipped', 'completed'].includes(decision)) {
          await requestWake({ prisma, runtime, triggerType: 'runtime_playbook_result', payload: { run_id: run.id, admin_checkin: true }, key: `first-life-admin-checkin:${run.id}:${decision}` });
          Promise.resolve(wakeScheduler?.()).catch(() => {});
        }
        return jsonResponse(res, { ok: true, decision, run: projectRuntimePlaybookSnapshot(resumed) }, 202);
      }

      const firstLifeStartMatch = pathname.match(/^\/v1\/hq\/first-life\/([^/]+)\/(?:start|policy)$/);
      const activationReviewMatch = firstLifeStartMatch
        || pathname.match(/^\/v1\/hq\/activation-sprints\/([^/]+)\/review$/);
      if (activationReviewMatch && req.method === 'POST') {
        const body = await parseBody(req).catch(() => ({}));
        const preference = String(body.preference || 'manual').toLowerCase();
        const sprint = await projectCurrentActivationSprint({ prisma, orgId });
        if (!sprint || sprint.id !== decodeURIComponent(activationReviewMatch[1])) return jsonResponse(res, { error: 'activation_sprint_not_found' }, 404);
        if (firstLifeStartMatch && sprint.policy?.id !== 'runtime.first-life-policy') {
          return jsonResponse(res, { error: 'first_life_not_found' }, 404);
        }
        const runtime = await getHqRuntime({ prisma, orgId });
        if (sprint.policy?.id === 'runtime.first-life-policy') {
          const decision = String(body.decision || (body.start === false ? 'review_later' : 'start')).toLowerCase();
          if (!['start', 'review_later'].includes(decision)) return jsonResponse(res, { error: 'first_life_decision_invalid' }, 400);
          if (!['AWAITING_START', 'REVIEW_LATER'].includes(sprint.status)) return jsonResponse(res, { error: 'first_life_start_already_recorded' }, 409);
          if (decision === 'review_later') {
            await prisma.$transaction((tx) => Promise.all((sprint.items || []).map(async (item) => {
              const todo = await tx.hqTodo.findFirst({ where: { id: item.todo_id, orgId }, select: { id: true, context: true } });
              if (!todo) return null;
              return tx.hqTodo.update({
                where: { id: todo.id },
                data: { context: { ...(todo.context || {}), first_life_reviewed_later: true } },
              });
            })));
            await appendHqEvent({
              prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
              eventType: 'observation', title: 'The first operating plan remains proposed',
              summary: 'No Room or provider work has started. The evidence-backed proposals remain available when you are ready.',
              details: { first_life_id: sprint.id, decision },
            });
            return jsonResponse(res, { ok: true, first_life_id: sprint.id, decision, promoted: [] }, 202);
          }
          const activation = await activateEligibleFirstLifeWork({
            prisma,
            runtime,
            expansionTrigger: 'user_start',
          });
          if (!activation.promoted.length) {
            return jsonResponse(res, {
              error: 'first_life_start_already_recorded',
              first_life_id: sprint.id,
              decision,
              promoted: [],
            }, 409);
          }
          await appendHqEvent({
            prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
            eventType: 'verification', title: 'Recommended work started',
            summary: `${activation.promoted.length} bounded proposal(s) became eligible for playbook selection. External authority remains unconfigured until an exact immutable action reaches its gate.`,
            details: { first_life_id: sprint.id, decision, promoted: activation.promoted },
          });
          for (const promoted of activation.promoted) await appendHqEvent({
            prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
            eventType: 'todo_created',
            title: `Promoted from the operating plan: ${promoted.title}`,
            summary: 'The proposal is now eligible for semantic playbook selection within the recorded concurrency policy.',
            details: { todo_id: promoted.id, effect_class: promoted.effect_class, expansion_trigger: 'user_start' },
          });
          if (activation.promoted.length) await requestWake({
            prisma, runtime, triggerType: 'queue_advance',
            payload: { first_life_id: sprint.id, promoted_todo_ids: activation.promoted.map((item) => item.id) },
            key: `first-life-start:${sprint.id}`,
          });
          Promise.resolve(wakeScheduler?.()).catch(() => {});
          return jsonResponse(res, { ok: true, first_life_id: sprint.id, decision, promoted: activation.promoted }, 202);
        }
        if (!['manual', 'auto'].includes(preference)) return jsonResponse(res, { error: 'activation_sprint_preference_invalid' }, 400);
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        if (!service) return jsonResponse(res, { error: 'runtime_playbook_service_unavailable' }, 503);
        const preflight = sprint.status === 'AWAITING_POLICY';
        const runIds = sprint.reviewable_run_ids || [];
        if (!preflight && !runIds.length) return jsonResponse(res, { error: 'activation_sprint_not_ready' }, 409);
        const grants = [];
        for (const runId of runIds) {
          const loaded = await service.executor.store.loadRun(runId, orgId);
          const playbook = service.registry.get(loaded.playbookId, loaded.playbookVersion, { scopeKey: loaded.scopeKey });
          const stage = playbook.stages.find((candidate) => candidate.id === loaded.currentStageId);
          if (!stage?.authority_gate || !stage?.authority_policy_key) continue;
          grants.push({ run: loaded, stage, inputHash: stageAuthorityHash(loaded, stage) });
        }
        const policyKeys = preflight
          ? (sprint.authority_policy_keys || [])
          : grants.map(({ stage }) => stage.authority_policy_key);
        if (!policyKeys.length) return jsonResponse(res, { error: 'activation_sprint_authority_policy_missing' }, 409);
        const policyPatch = Object.fromEntries(policyKeys.map((key) => [key, preference]));
        await prisma.$transaction(async (tx) => {
          await tx.hqRuntime.update({ where: { id: runtime.id }, data: { authorityPolicy: { ...(runtime.authorityPolicy || {}), ...policyPatch }, version: { increment: 1 } } });
          for (const { run, stage, inputHash } of preflight ? [] : grants) {
            await tx.runtimePlaybookAuthority.upsert({
              where: { runId_gate: { runId: run.id, gate: stage.authority_gate } },
              create: { runId: run.id, orgId, gate: stage.authority_gate, grantedBy: userId, payload: { preference, input_hash: inputHash, activation_sprint_id: sprint.id } },
              update: { status: 'GRANTED', grantedBy: userId, payload: { preference, input_hash: inputHash, activation_sprint_id: sprint.id }, grantedAt: new Date(), revokedAt: null },
            });
          }
        });
        await appendHqEvent({
          prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
          eventType: 'verification',
          title: preflight ? 'First Growth Sprint operating policy recorded' : 'First Growth Sprint launch authority recorded',
          summary: preflight
            ? `${preference === 'auto' ? 'Auto' : 'Manual review'} now governs the first sprint's external actions. No campaign, message, or call was launched by this policy choice; each playbook must still prepare and verify its exact batch before its authority gate.`
            : `I bound ${grants.length} exact launch batch${grants.length === 1 ? '' : 'es'} to ${preference === 'auto' ? 'automatic' : 'manual'} organization policy and resumed their existing lifecycles.`,
          details: { activation_sprint_id: sprint.id, run_ids: grants.map(({ run }) => run.id), policy_keys: policyKeys, preference, phase: preflight ? 'preflight' : 'exact_batch' },
        });
        if (!preflight) await Promise.all(grants.map(({ run }) => service.execute(run.id, orgId)));
        if (preflight) await requestWake({
          prisma, runtime, triggerType: 'queue_advance',
          payload: { activation_sprint_id: sprint.id, authority_policy_keys: policyKeys },
          key: `activation-sprint-policy:${sprint.id}:${preference}`,
        });
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { ok: true, sprint_id: sprint.id, resumed: grants.map(({ run }) => run.id), preference }, 202);
      }

      const playbookSnapshotMatch = pathname.match(/^\/v1\/hq\/playbooks\/runs\/([0-9a-f-]{36})\/snapshot$/i);
      if (playbookSnapshotMatch && req.method === 'GET') {
        const snapshot = await loadRuntimePlaybookSnapshot(prisma, playbookSnapshotMatch[1], orgId);
        return snapshot ? jsonResponse(res, { snapshot }) : jsonResponse(res, { error: 'runtime_playbook_run_not_found' }, 404);
      }

      if (pathname === '/v1/hq/playbooks/runs' && req.method === 'GET') {
        const runs = await prisma.runtimePlaybookRun.findMany({
          where: { orgId }, orderBy: { updatedAt: 'desc' }, take: 100,
          include: {
            artifacts: { where: { status: { not: 'SUPERSEDED' } }, orderBy: { createdAt: 'asc' } },
            checkpoints: { orderBy: { sequence: 'asc' } },
            authorities: { orderBy: { grantedAt: 'asc' } },
          },
        });
        return jsonResponse(res, { runs });
      }

      if (pathname === '/v1/hq/playbooks/runs' && req.method === 'POST') {
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        if (!service) return jsonResponse(res, { error: 'runtime_playbook_service_unavailable' }, 503);
        const body = await parseBody(req).catch(() => ({}));
        const objective = String(body.objective || '').trim().slice(0, 8000);
        const roomId = String(body.room_id || '').trim();
        if (!objective || !roomId) return jsonResponse(res, { error: 'runtime_playbook_objective_and_room_required' }, 400);
        const room = await prisma.hyperRoom.findFirst({ where: { id: roomId, orgId, archivedAt: null }, select: { id: true } });
        if (!room) return jsonResponse(res, { error: 'runtime_playbook_room_not_found' }, 404);
        const created = await service.tryCreateAssignment({
          orgId, roomId, objective,
          idempotencyKey: String(body.idempotency_key || `user:${userId}:${Date.now()}`).slice(0, 180),
          trigger: body.trigger || { type: 'user_request', payload: body.payload || {} },
          context: body.context || {},
          scopeKey: String(body.scope_key || 'global').slice(0, 80),
        });
        if (!created.matched) return jsonResponse(res, { error: 'runtime_playbook_no_compatible_lifecycle', selection: created.selection }, 422);
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, created, 201);
      }

      const playbookInputMatch = pathname.match(/^\/v1\/hq\/playbooks\/runs\/([0-9a-f-]{36})\/inputs\/([a-z0-9._-]{1,120})$/i);
      if (playbookInputMatch && req.method === 'POST') {
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        if (!service) return jsonResponse(res, { error: 'runtime_playbook_service_unavailable' }, 503);
        const body = await parseBody(req).catch(() => ({}));
        if (!Object.prototype.hasOwnProperty.call(body, 'value')) {
          return jsonResponse(res, { error: 'runtime_playbook_input_value_required' }, 400);
        }
        const run = await prisma.runtimePlaybookRun.findFirst({ where: { id: playbookInputMatch[1], orgId } });
        if (!run) return jsonResponse(res, { error: 'runtime_playbook_run_not_found' }, 404);
        const inputKey = playbookInputMatch[2];
        const waiting = run.waitingFor && typeof run.waitingFor === 'object' ? run.waitingFor : {};
        if (run.status !== 'WAITING_EVENT' || !(waiting.types || [waiting.type]).includes('input.provided')) {
          return jsonResponse(res, { error: 'runtime_playbook_input_not_waiting' }, 409);
        }
        const acceptedKeys = (waiting.correlation_values || [waiting.correlation_value]).filter(Boolean).map(String);
        if (acceptedKeys.length && !acceptedKeys.includes(inputKey)) {
          return jsonResponse(res, { error: 'runtime_playbook_input_key_mismatch', expected: acceptedKeys }, 409);
        }
        const requestArtifact = await prisma.runtimePlaybookArtifact.findFirst({
          where: { runId: run.id, artifactKey: 'input_request' },
          orderBy: { createdAt: 'desc' },
        });
        const requestData = requestArtifact?.data && typeof requestArtifact.data === 'object' ? requestArtifact.data : {};
        if (requestData.input_key && String(requestData.input_key) !== inputKey) {
          return jsonResponse(res, { error: 'runtime_playbook_input_contract_mismatch' }, 409);
        }
        let value = body.value;
        if (requestData.value_type === 'email') {
          value = String(value || '').trim().toLowerCase();
          if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
            return jsonResponse(res, { error: 'runtime_playbook_input_email_invalid' }, 400);
          }
        } else if (requestData.value_type === 'phone') {
          value = String(value || '').replace(/[\s()/-]/g, '');
          if (!/^\+[1-9]\d{6,14}$/.test(value)) {
            return jsonResponse(res, { error: 'runtime_playbook_input_phone_invalid' }, 400);
          }
        }
        const context = run.context && typeof run.context === 'object' ? run.context : {};
        await prisma.runtimePlaybookRun.update({
          where: { id: run.id },
          data: { context: {
            ...context,
            supplied_inputs: { ...(context.supplied_inputs || {}), [inputKey]: value },
          } },
        });
        const resumed = await service.resumeEvent(run.id, orgId, {
          id: `input:${run.id}:${inputKey}:${Date.now()}`,
          type: 'input.provided',
          data: { input_key: inputKey },
        });
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { run: resumed, input_key: inputKey }, 202);
      }

      const playbookAuthorityMatch = pathname.match(/^\/v1\/hq\/playbooks\/runs\/([0-9a-f-]{36})\/authority$/i);
      if (playbookAuthorityMatch && req.method === 'POST') {
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        if (!service) return jsonResponse(res, { error: 'runtime_playbook_service_unavailable' }, 503);
        const body = await parseBody(req).catch(() => ({}));
        const gate = String(body.gate || '').trim().slice(0, 120);
        if (!gate) return jsonResponse(res, { error: 'runtime_playbook_authority_gate_required' }, 400);
        const run = await prisma.runtimePlaybookRun.findFirst({ where: { id: playbookAuthorityMatch[1], orgId } });
        if (!run || run.status !== 'WAITING_AUTHORITY') return jsonResponse(res, { error: 'runtime_playbook_authority_not_waiting' }, 409);
        const playbook = service.registry.get(run.playbookId, run.playbookVersion, { scopeKey: run.scopeKey });
        const stage = playbook.stages.find((candidate) => candidate.id === run.currentStageId);
        if (!stage || stage.authority_gate !== gate || !stage.authority_policy_key) {
          return jsonResponse(res, { error: 'runtime_playbook_authority_stage_mismatch' }, 409);
        }
        if (typeof body.approve !== 'boolean') return jsonResponse(res, { error: 'runtime_playbook_authority_approve_required' }, 400);
        const preference = body.preference == null ? null : String(body.preference).toLowerCase();
        if (preference && !['auto', 'manual'].includes(preference)) {
          return jsonResponse(res, { error: 'runtime_playbook_authority_preference_invalid' }, 400);
        }
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        if (stage.authority_policy_mode === 'manual_only' && preference === 'auto') {
          return jsonResponse(res, { error: 'runtime_playbook_authority_manual_only' }, 409);
        }
        if (preference) {
          const policyValue = preference;
          const policy = normalizeAuthorityPolicy({
            ...(runtime.authorityPolicy || {}),
            gate_overrides: { ...(runtime.authorityPolicy?.gate_overrides || {}), [stage.authority_policy_key]: policyValue },
          });
          await prisma.hqRuntime.updateMany({
            where: { id: runtime.id, orgId, epoch: runtime.epoch },
            data: { authorityPolicy: policy, version: { increment: 1 } },
          });
          await appendHqEvent({
            prisma, runtimeId: runtime.id, orgId, runtimeEpoch: runtime.epoch,
            eventType: 'verification',
            title: preference === 'auto' ? 'Automatic gate policy recorded' : 'Manual gate review retained',
            summary: preference === 'auto'
              ? `Future verified checkpoints governed by ${stage.authority_policy_key} may use Auto. This did not grant any different artifact batch.`
              : `Future checkpoints governed by ${stage.authority_policy_key} will wait for an explicit approval decision.`,
            details: { policy_key: stage.authority_policy_key, preference: policyValue, run_id: run.id },
          });
        }
        const approve = body.approve;
        if (approve) {
          const loadedRun = await service.executor.store.loadRun(run.id, orgId);
          await service.grantAuthority(run.id, orgId, gate, { grantedBy: userId, payload: { ...(body.payload || {}), preference: preference || null, input_hash: stageAuthorityHash(loadedRun, stage) } });
        }
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { ok: true, approved: approve, preference: preference || null }, approve ? 202 : 200);
      }

      const playbookEventMatch = pathname.match(/^\/v1\/hq\/playbooks\/runs\/([0-9a-f-]{36})\/events$/i);
      if (playbookEventMatch && req.method === 'POST') {
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        if (!service) return jsonResponse(res, { error: 'runtime_playbook_service_unavailable' }, 503);
        const body = await parseBody(req).catch(() => ({}));
        const event = body.event && typeof body.event === 'object' ? body.event : {};
        if (!event.type) return jsonResponse(res, { error: 'runtime_playbook_event_type_required' }, 400);
        const run = await service.resumeEvent(playbookEventMatch[1], orgId, event);
        return jsonResponse(res, { run }, 202);
      }

      const playbookInterventionMatch = pathname.match(/^\/v1\/hq\/playbooks\/runs\/([0-9a-f-]{36})\/resume$/i);
      if (playbookInterventionMatch && req.method === 'POST') {
        const service = typeof runtimePlaybooks === 'function' ? runtimePlaybooks() : runtimePlaybooks;
        if (!service) return jsonResponse(res, { error: 'runtime_playbook_service_unavailable' }, 503);
        const body = await parseBody(req).catch(() => ({}));
        const checkpointSequence = Number(body.checkpoint_sequence);
        const reason = String(body.reason || '').trim().slice(0, 1000);
        if (!Number.isInteger(checkpointSequence) || checkpointSequence < 0) {
          return jsonResponse(res, { error: 'runtime_intervention_checkpoint_required' }, 400);
        }
        if (!reason) return jsonResponse(res, { error: 'runtime_intervention_reason_required' }, 400);
        const run = await prisma.runtimePlaybookRun.findFirst({
          where: { id: playbookInterventionMatch[1], orgId },
          select: { id: true, status: true, checkpointSequence: true },
        });
        if (!run) return jsonResponse(res, { error: 'runtime_playbook_run_not_found' }, 404);
        if (run.status !== 'NEEDS_INTERVENTION') {
          return jsonResponse(res, { error: 'runtime_intervention_not_waiting' }, 409);
        }
        if (run.checkpointSequence !== checkpointSequence) {
          return jsonResponse(res, { error: 'runtime_intervention_checkpoint_stale', checkpoint_sequence: run.checkpointSequence }, 409);
        }
        const resumed = await service.resumeIntervention(run.id, orgId, {
          expectedCheckpointSequence: checkpointSequence,
          resumedBy: userId,
          reason,
        });
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { run: resumed }, 202);
      }

      if (pathname === '/v1/hq/instructions' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const body = await parseBody(req).catch(() => ({}));
        const instructionBody = String(body.instruction || '').trim().slice(0, 5000);
        if (!instructionBody) return jsonResponse(res, { error: 'hq_instruction_required' }, 400);
        const instruction = await prisma.hqInstruction.create({ data: { runtimeId: runtime.id, orgId, userId, body: instructionBody } });
        const schedule = await requestWake({ prisma, runtime, triggerType: 'instruction_updated', payload: { instruction_id: instruction.id }, key: `instruction:${instruction.id}` });
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { instruction, schedule }, 201);
      }

      if (pathname === '/v1/hq/capabilities/recheck' && req.method === 'POST') {
        const runtime = await getHqRuntime({ prisma, orgId });
        if (!runtime) return jsonResponse(res, { error: 'hq_runtime_not_found' }, 404);
        const result = await reconcileRuntimeCapabilities({ prisma, runtime, wakeScheduler });
        // No custom key here — a Date.now()-suffixed key was unique every call,
        // defeating the orgId+idempotencyKey dedup and turning rapid /recheck
        // polling into a full HQ wake-and-reprocess cycle on every single call
        // (observed as a sub-second noise storm for a still-unresolved
        // capability). requestWake's own default key (triggerType + minute
        // bucket) coalesces repeated rechecks to at most one real wake/minute.
        const schedule = result.resolved.length ? null : await requestWake({ prisma, runtime, triggerType: 'connector_changed' });
        Promise.resolve(wakeScheduler?.()).catch(() => {});
        return jsonResponse(res, { schedule, resolved: result.resolved, platform_managed: result.platform_managed }, 202);
      }

      if (pathname === '/v1/hq/resources' && req.method === 'GET') {
        const [baselines, plans, journal] = await Promise.all([
          prisma.sourceArtifact.findMany({ where: { orgId, sourcePlatform: 'growth_baseline', artifactType: 'api_response' }, select: { id: true, sourceId: true, createdAt: true, metadata: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
          prisma.sourceArtifact.findMany({ where: { orgId, sourcePlatform: 'growth_plan', artifactType: 'api_response' }, select: { id: true, sourceId: true, createdAt: true, metadata: true }, orderBy: { createdAt: 'desc' }, take: 20 }),
          prisma.growthJournal.findMany({ where: { orgId }, orderBy: { createdAt: 'desc' }, take: 50 }),
        ]);
        return jsonResponse(res, { baselines, growth_plans: plans, journal });
      }

      return false;
    } catch (error) {
      console.warn('[hq-runtime] route failed:', error.message);
      return jsonResponse(res, { error: 'hq_runtime_request_failed', message: error.message }, 503);
    }
  };
}

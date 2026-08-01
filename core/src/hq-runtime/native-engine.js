import { appendHqEvent, scheduleHqWake, transitionHqRuntime } from './repository.js';
import { buildHqContext } from './context.js';
import { HqSkillRegistry, HqToolkitRegistry } from './skill-registry.js';
import { ingestPendingInstructions, reconcileTodoCapabilities } from './instruction-loop.js';
import { narrateAwakening } from './awakening-narrator.js';

const DAY = 86400000;

const metric = (value) => Number(value || 0).toLocaleString('en-US');
export const boundedDelegationField = (value) => String(value || '').slice(0, 500);

export function summarizeBaselineResult(baseline = {}) {
  const social = baseline.social_presence && typeof baseline.social_presence === 'object' ? baseline.social_presence : {};
  const followers = Array.isArray(social.followers) ? social.followers : [];
  const followerSummary = followers.map((row) => {
    const platform = String(row?.platform || 'channel').toLowerCase() === 'twitter' ? 'X' : String(row?.platform || 'channel').replace(/^./, (value) => value.toUpperCase());
    return `${platform}: ${metric(row?.currentFollowers ?? row?.current_followers)} followers`;
  });
  const totals = social.totals && typeof social.totals === 'object' ? social.totals : {};
  const activity = [
    `${metric(totals.impressions)} impressions`, `${metric(totals.reach)} reach`,
    `${metric(totals.likes)} likes`, `${metric(totals.clicks)} clicks`,
  ];
  const pages = Number(baseline.website?.mapped_pages || 0);
  const gaps = Array.isArray(baseline.data_gaps) ? baseline.data_gaps.filter(Boolean) : [];
  return {
    summary: `I found ${pages} website page(s). ${followerSummary.length ? `${followerSummary.join('; ')}. ` : 'No follower totals were returned. '}${activity.join(', ')} across the observed window.${gaps.length ? ` I retained ${gaps.length} evidence gap(s) for planning.` : ''}`,
    details: { website_pages: pages, followers: followers.map((row) => ({ platform: row.platform, username: row.username, current_followers: Number(row.currentFollowers ?? row.current_followers ?? 0), growth: Number(row.growth || 0), growth_percentage: Number(row.growthPercentage ?? row.growth_percentage ?? 0) })), totals, evidence_gaps: gaps },
  };
}

export function summarizeGrowthPlanResult(result = {}) {
  const constraints = (Array.isArray(result.plan?.constraints) ? result.plan.constraints : []).map((item) => String(item?.type || item?.statement || '')).filter(Boolean);
  const todos = (Array.isArray(result.plan?.operating_queue) ? result.plan.operating_queue : []).map((item, index) => `${index + 1}. ${item.title} -> ${item.room_tag}`);
  return {
    summary: `I ranked ${constraints.length} material constraint(s): ${constraints.join(', ') || 'none'}. I committed ${todos.length} ordered todo(s): ${todos.join('; ') || 'none'}.`,
    details: { constraints: result.plan?.constraints || [], operating_queue: result.plan?.operating_queue || [], todo_ids: result.committed?.todo_ids || [] },
  };
}

async function event(prisma, runtime, cycle, input) {
  return appendHqEvent({ prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch, cycleId: cycle.id, ...input });
}

export function resolveWorkResultTodo({ order, result }) {
  if (!order || !result) return null;
  const resultOutput = result.output && typeof result.output === 'object' ? result.output : {};
  return {
    resultOutput,
    todoId: resultOutput.todo_id || order.inputSnapshot?.todo_id || null,
  };
}

export function fallbackRoomTag(todo, available) {
  const exact = String(todo?.context?.room_tag || todo?.context?.specialist_room || '').trim().toLowerCase();
  if (available.includes(exact)) return exact;
  return available.includes('general') ? 'general' : null;
}

export function specialistWorkObjective(todo, skillId) {
  return String(todo?.objective || todo?.title || '').trim();
}

export function compileCompletionRequirements(todo) {
  const context = todo?.context && typeof todo.context === 'object' ? todo.context : {};
  return Array.isArray(context.completion_requirements)
    ? context.completion_requirements.filter((row) => row && typeof row === 'object' && row.type)
    : [];
}

async function selectSpecialistRoomTag(todo, skillId, availableRooms) {
  const catalog = availableRooms.map((room) => ({
    tag: String(room?.roomTag || '').trim().toLowerCase(),
    name: String(room?.name || '').trim(),
    goal: String(room?.goal || '').trim(),
  })).filter((room) => room.tag);
  const candidates = [...new Set(catalog.map((room) => room.tag))];
  const requiredOwner = String(todo?.context?.room_tag || todo?.context?.specialist_room || '').trim().toLowerCase();
  if (requiredOwner) return requiredOwner;
  if (!candidates.length) return null;
  const fallback = fallbackRoomTag(todo, candidates);
  const apiKey = process.env.GROQ_API_KEY || process.env.GROQ_KEY || '';
  if (!apiKey) return fallback;
  try {
    const response = await fetch(`${process.env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1'}/chat/completions`, {
      method: 'POST', signal: AbortSignal.timeout(12000),
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: process.env.HQ_DISPATCH_MODEL || 'openai/gpt-oss-120b', temperature: 0,
        response_format: { type: 'json_object' }, max_tokens: 180,
        messages: [
          { role: 'system', content: 'Route one durable company work order to exactly one available specialist Room. Classify by meaning in any language, never by keyword occurrence. The bounded objective and work kind outrank broad standing instructions. Return JSON only: {"room_tag":"one exact available tag","reason":"short reason"}.' },
          { role: 'user', content: JSON.stringify({ work_kind: todo?.kind, title: todo?.title, objective: todo?.objective, selected_skill: skillId, available_rooms: catalog }) },
        ],
      }),
    });
    if (!response.ok) return fallback;
    const payload = await response.json();
    const parsed = JSON.parse(String(payload?.choices?.[0]?.message?.content || '{}'));
    const selected = String(parsed?.room_tag || '').trim().toLowerCase();
    return candidates.includes(selected) ? selected : fallback;
  } catch {
    return fallback;
  }
}

export function verifySpecialistDelivery({ order, result, resultOutput }) {
  const status = String(result?.status || '').toLowerCase();
  const summary = String(result?.summary || '').trim();
  const failures = [];
  if (status !== 'completed') failures.push(`terminal_status:${status || 'missing'}`);
  if (!summary) failures.push('summary_missing');
  if (resultOutput.code === 'company_identity_mismatch') failures.push('company_identity_mismatch');
  const output = resultOutput && typeof resultOutput === 'object' ? resultOutput : {};
  const completionRequirements = Array.isArray(order?.inputSnapshot?.completion_requirements)
    ? order.inputSnapshot.completion_requirements : [];
  const contract = output.work_order_result && typeof output.work_order_result === 'object'
    ? output.work_order_result : null;
  const requirementResults = Array.isArray(contract?.completion_requirements)
    ? contract.completion_requirements : [];
  for (const requirement of completionRequirements) {
    const check = requirementResults.find((row) => row?.type === requirement?.type);
    if (!check || check.met !== true) failures.push(`completion_requirement_unmet:${requirement?.type || 'unknown'}`);
  }
  if (completionRequirements.length && !contract) failures.push('completion_contract_missing');
  if (contract && String(contract.status || '').toLowerCase() !== 'completed') failures.push(`contract_status:${contract.status || 'missing'}`);
  return { accepted: failures.length === 0, failures };
}

export function resolveAuthorityDecision(stage, authorityPolicy = {}) {
  const gate = String(stage?.authority_gate || '').trim() || null;
  const policyKey = String(stage?.authority_policy_key || '').trim() || null;
  return {
    gate,
    policyKey,
    autoGrant: Boolean(gate && policyKey && authorityPolicy?.[policyKey] === 'auto'),
  };
}

export class NativeHqEngine {
  constructor({ prisma, logger = console, runtimePlaybooks = null }) {
    this.prisma = prisma;
    this.logger = logger;
    this.runtimePlaybooks = runtimePlaybooks;
    this.skills = new HqSkillRegistry();
    this.toolkits = new HqToolkitRegistry();
  }

  async runCycle({ runtime, cycle, trigger }) {
    const prisma = this.prisma;
    if (!runtime?.epoch || !cycle?.runtimeEpoch || String(runtime.epoch) !== String(cycle.runtimeEpoch)) {
      throw new Error('hq_cycle_runtime_epoch_obsolete');
    }
    let state = runtime.state;
    const move = async (to, data = {}) => {
      runtime = await transitionHqRuntime({ prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch, from: state, to, data });
      state = to;
    };
    if (state === 'WAITING' && ['work_result', 'runtime_playbook_result'].includes(trigger.type)) {
      await move('REVIEWING', { blockedReason: null });
    } else if (state === 'WAITING' || state === 'BLOCKED') {
      await move('OBSERVING', { blockedReason: null });
    }
    const firstAwakening = trigger.type === 'onboarding_complete' || trigger.type === 'user_first_activation';
    const restartAwakening = firstAwakening && Boolean(trigger.payload?.restart);
    let context = await buildHqContext({ prisma, runtime, trigger });
    const awakening = firstAwakening ? await narrateAwakening({
      company: context.company,
      objective: runtime.objective,
      capabilities: [...context.capabilities.connected, ...context.capabilities.platform_managed],
      restart: restartAwakening,
      fallbackApiKey: process.env.GROQ_API_KEY,
    }) : null;
    await event(prisma, runtime, cycle, { eventType: 'wake', title: firstAwakening ? 'I am here' : 'I am awake', summary: firstAwakening
      ? awakening.narration
      : `I am awake. ${String(trigger.type || 'An event').replaceAll('_', ' ')} moved, so I am reading the company before I touch anything.`, details: firstAwakening ? { narration_model: awakening.model, narration_fallback: awakening.fallback, usage: awakening.usage } : {} });
    await event(prisma, runtime, cycle, {
      eventType: 'context_loaded', title: 'I have the company in view',
      summary: `${String(context.company?.company || context.company?.name || context.company?.profile?.name || 'The company')} has ${context.evidence.baseline ? 'a retained baseline' : 'no current baseline yet'}, ${context.pending_work.length} active work order(s), and ${context.capabilities.connected.length} connected capability${context.capabilities.connected.length === 1 ? '' : 'ies'}. I will use only what is actually present.`,
      evidenceRefs: [context.evidence.baseline?.id, context.evidence.latest_growth_plan?.id].filter(Boolean),
    });

    const baselineMissingBeforeCollection = !context.evidence.baseline;
    const buildingInitialPlan = !context.evidence.latest_growth_plan;
    const appliedInstructions = await ingestPendingInstructions({
      prisma, runtime, company: context.company, deferTodos: buildingInitialPlan,
    });
    if (!appliedInstructions.length && !firstAwakening) await event(prisma, runtime, cycle, {
      eventType: 'instruction_checked', title: 'I checked for new operating instructions',
      summary: 'No unapplied instruction changed the operating queue. I will use the current priorities rather than replaying old work.',
    });
    for (const applied of appliedInstructions) {
      await event(prisma, runtime, cycle, {
        eventType: 'instruction_received', title: 'I have accepted a new operating instruction',
        summary: applied.instruction.body, details: { instruction_id: applied.instruction.id, interpretation: applied.interpreted },
      });
      if (applied.todo) {
        for (const [index, todo] of (applied.todos || [applied.todo]).entries()) await event(prisma, runtime, cycle, {
          eventType: 'todo_created',
          title: index === 0 ? `Added to my operating queue: ${todo.title}` : `Queued after its dependency: ${todo.title}`,
          summary: todo.objective,
          details: { todo_id: todo.id, status: todo.status, workflow_index: index,
            required_capabilities: todo.requiredCapabilities, depends_on_todo_id: todo.context?.depends_on_todo_id || null },
          skillRef: todo.context?.skill || applied.interpreted.skill,
        });
      }
      else await event(prisma, runtime, cycle, {
        eventType: 'observation', title: 'I retained this requirement for the first operating plan',
        summary: 'I will not turn it into isolated work before the baseline and company-wide constraint ranking are complete.',
        details: { instruction_id: applied.instruction.id, interpretation: applied.interpreted },
      });
    }
    const capabilityState = await reconcileTodoCapabilities({ prisma, runtime });
    for (const resolved of capabilityState.resolved) await event(prisma, runtime, cycle, {
      eventType: 'capability_resolved', title: 'A required capability is available',
      summary: `${resolved.platform_managed?.length ? `${resolved.platform_managed.join(', ')} is provided by the platform.` : `I verified ${resolved.capabilities.join(', ')} against this organization.`} The blocked todo is ready again, so I am continuing from it instead of rebuilding the plan.`,
      details: resolved,
    });
    for (const request of baselineMissingBeforeCollection ? [] : capabilityState.requests) {
      const alreadyShown = await prisma.hqRuntimeEvent.findFirst({ where: { runtimeId: runtime.id, eventType: 'capability_required', details: { path: ['capability_request_id'], equals: request.id } } }).catch(() => null);
      if (!alreadyShown) await event(prisma, runtime, cycle, {
        eventType: 'capability_required', title: `I need ${request.provider} to continue`, summary: request.reason,
        details: { capability_request_id: request.id, todo_id: request.todoId, provider: request.provider, connect_path: request.connectPath },
      });
    }
    const readyTodo = capabilityState.todos.find((todo) => todo.status === 'READY');
    if (!firstAwakening || readyTodo) await event(prisma, runtime, cycle, {
      eventType: 'queue_checked', title: 'I re-ranked the operating queue',
      summary: readyTodo
        ? `The next executable priority is ${readyTodo.title}. Waiting items remain retained but will not stall safe work behind them.`
        : 'There is no executable todo ahead of the active stage. I will wait only for the evidence or capability that can change the next decision.',
      details: { next_todo_id: readyTodo?.id || null, platform_managed_capabilities: capabilityState.platform_managed || [] },
    });

    const forceBaseline = Boolean(trigger.payload?.restart || trigger.payload?.fresh_start) && !context.evidence.baseline;
    const baselineMissing = forceBaseline || !context.evidence.baseline;
    const baselineStale = !baselineMissing && (!context.evidence.company_identity.matches || !context.evidence.company_identity.current_onboarding);
    if (baselineMissing || baselineStale) {
      const baselineSkill = this.skills.load('baseline-establishment');
      const [baselineToolkit] = this.toolkits.select(['growth_baseline']);
      await event(prisma, runtime, cycle, {
        eventType: 'skill_loaded', title: 'I need an exact starting position',
        summary: baselineSkill.description, skillRef: baselineSkill.id,
        details: { model_policy: baselineSkill.model_policy || { mode: 'deterministic_tools', model: null } },
      });
      await event(prisma, runtime, cycle, {
        eventType: 'tool_started', title: 'I am establishing the company baseline',
        summary: forceBaseline ? 'Runtime restart requested a fresh full source transfer from the post-onboarding boundary.' : baselineStale ? 'The company changed, so I am replacing stale evidence with a full source transfer.' : 'No baseline exists, so I am collecting the first full source transfer.',
        toolRef: 'growth_baseline_collect', details: { toolkit: baselineToolkit.id, depth: 'full_transfer', model: null },
      });
      try {
        const baseline = await this.toolkits.invoke('growth_baseline', 'collect', {
          mode: 'full_all', scheduleRuntimeWake: false,
        }, { prisma, orgId: runtime.orgId, userId: runtime.ownerUserId });
        const acknowledged = summarizeBaselineResult(baseline);
        await event(prisma, runtime, cycle, {
          eventType: 'tool_result', title: 'I have established the current position',
          summary: acknowledged.summary,
          toolRef: 'growth_baseline_collect', evidenceRefs: [baseline.resource_id],
          details: { toolkit: baselineToolkit.id, resource_id: baseline.resource_id, model: null, usage: { prompt_tokens: 0, completion_tokens: 0 }, ...acknowledged.details },
        });
        context = await buildHqContext({ prisma, runtime, trigger });
      } catch (error) {
        await move('BLOCKED', { blockedReason: error.message });
        await event(prisma, runtime, cycle, { eventType: 'blocked', title: 'I cannot establish a trustworthy baseline', summary: `The evidence door is closed: ${error.message}. I will not invent a company position to keep the interface moving.`, skillRef: baselineSkill.id, toolRef: 'growth_baseline_collect' });
        return { transition: 'ESCALATE', reason: 'baseline_collection_failed' };
      }
    }

    if (!context.evidence.baseline || !context.evidence.company_identity.matches || !context.evidence.company_identity.current_onboarding) {
      await move('BLOCKED', { blockedReason: 'Fresh baseline did not reconcile with the current company identity.' });
      await event(prisma, runtime, cycle, { eventType: 'blocked', title: 'I stopped before acting on mixed company evidence', summary: 'The evidence still describes more than one company. Motion would look productive and be wrong. I will not delegate from an uncertain identity.' });
      return { transition: 'ESCALATE', reason: 'baseline_company_mismatch' };
    }

    const websitePages = Number(context.evidence.baseline.website_pages || 0);
    const socialAccountCount = Number(context.evidence.baseline.social_accounts || 0);
    const recentPostCount = Number(context.evidence.baseline.recent_posts || 0);
    const missingEvidence = [
      websitePages === 0 ? 'website' : null,
      socialAccountCount === 0 ? 'connected social accounts' : null,
      recentPostCount === 0 ? 'recent social activity' : null,
    ].filter(Boolean);
    if (missingEvidence.length) {
      await event(prisma, runtime, cycle, {
        eventType: 'observation', title: 'I recorded the baseline evidence gaps',
        summary: `The initial position is usable only with limits. I could not observe ${missingEvidence.join(', ')}. I will not present those areas as measured; the next plan must treat them as unknowns and request access when the task depends on them.`,
        details: { missing_evidence: missingEvidence, website_pages: websitePages, social_accounts: socialAccountCount, recent_posts: recentPostCount, baseline_id: context.evidence.baseline.id },
        evidenceRefs: [context.evidence.baseline.id],
      });
    }
    if (baselineMissingBeforeCollection) {
      for (const request of capabilityState.requests) await event(prisma, runtime, cycle, {
        eventType: 'capability_required', title: `I need ${request.provider} to continue`, summary: request.reason,
        details: { capability_request_id: request.id, todo_id: request.todoId, provider: request.provider, connect_path: request.connectPath },
      });
    }

    let queueContinuationScheduled = false;
    if (trigger.type === 'runtime_playbook_result') {
      const runId = String(trigger.payload?.run_id || '');
      const run = runId ? await prisma.runtimePlaybookRun.findFirst({
        where: { id: runId, orgId: runtime.orgId },
        include: { artifacts: { orderBy: { createdAt: 'asc' } }, checkpoints: { orderBy: { sequence: 'asc' } } },
      }) : null;
      const todoId = String(run?.trigger?.todo_id || trigger.payload?.todo_id || '');
      const todo = todoId ? await prisma.hqTodo.findFirst({ where: { id: todoId, runtimeId: runtime.id, orgId: runtime.orgId } }) : null;
      if (!run || !todo) {
        await move('BLOCKED', { blockedReason: 'A playbook result arrived without its durable run or owning todo.' });
        await event(prisma, runtime, cycle, {
          eventType: 'blocked', title: 'Playbook result could not be reconciled',
          summary: 'HQ retained the event and stopped rather than guessing which operating item it completed.',
          details: { run_id: runId, todo_id: todoId || null },
        });
        return { transition: 'ESCALATE', reason: 'runtime_playbook_result_missing' };
      }
      const artifactRefs = run.artifacts.map((artifact) => artifact.artifactId);
      if (run.status === 'WAITING_AUTHORITY') {
        const playbook = this.runtimePlaybooks?.registry.get(run.playbookId, run.playbookVersion, { scopeKey: run.scopeKey });
        const stage = playbook?.stages?.find((candidate) => candidate.id === run.currentStageId);
        const authority = resolveAuthorityDecision(stage, runtime.authorityPolicy);
        if (authority.autoGrant) {
          await this.runtimePlaybooks.grantAuthority(run.id, runtime.orgId, authority.gate, {
            grantedBy: runtime.ownerUserId,
            payload: { source: 'organization_policy', policy_key: authority.policyKey },
          });
          await prisma.hqTodo.update({ where: { id: todo.id }, data: { status: 'RUNNING', blockedReason: null } });
          await event(prisma, runtime, cycle, {
            eventType: 'verification', title: `Authority granted by organization policy: ${todo.title}`,
            summary: `The ${authority.policyKey} policy is Auto. The exact checkpoint is authorized and the lifecycle will continue without broadening its scope.`,
            details: { run_id: run.id, gate: authority.gate, policy_key: authority.policyKey },
          });
        } else {
          await prisma.hqTodo.update({ where: { id: todo.id }, data: {
            status: 'WAITING_FOR_AUTHORITY', blockedReason: `Approval required for ${authority.policyKey || 'this checkpoint'}.`,
            result: { runtime_playbook_run_id: run.id, authority_gate: authority.gate, authority_policy_key: authority.policyKey },
          } });
          await event(prisma, runtime, cycle, {
            eventType: 'approval_required', title: `Approval required: ${todo.title}`,
            summary: 'The Room completed the preparatory stages. HQ is holding the exact checkpoint before any governed external action.',
            details: { run_id: run.id, gate: authority.gate, policy_key: authority.policyKey },
          });
        }
      } else {
        const completed = run.status === 'COMPLETED';
        await prisma.hqTodo.update({
          where: { id: todo.id },
          data: {
            status: completed ? 'COMPLETED' : 'BLOCKED',
            completedAt: completed ? new Date() : null,
            blockedReason: completed ? null : JSON.stringify(run.lastVerdict || {}).slice(0, 2000),
            result: {
              runtime_playbook_run_id: run.id,
              playbook_id: run.playbookId,
              playbook_version: run.playbookVersion,
              terminal_state: run.terminalState,
              status: run.status,
              artifact_refs: artifactRefs,
              last_verdict: run.lastVerdict || {},
            },
          },
        });
        await event(prisma, runtime, cycle, {
          eventType: completed ? 'decision' : 'blocked',
          title: completed ? `Completed: ${todo.title}` : `Playbook needs intervention: ${todo.title}`,
          summary: completed
            ? `The versioned lifecycle reached ${run.terminalState} after ${run.completedStageIds.length} checkpointed stage(s). HQ accepted ${artifactRefs.length} durable artifact(s).`
            : 'The lifecycle stopped at a failed predicate or terminal safety condition. Exact unmet checks remain attached to the run.',
          details: { run_id: run.id, playbook_id: run.playbookId, terminal_state: run.terminalState, artifact_refs: artifactRefs, verdict: run.lastVerdict || {} },
          evidenceRefs: artifactRefs,
        });
        await scheduleHqWake({
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
          idempotencyKey: `queue-after-playbook:${run.id}`, triggerType: 'queue_advance', dueAt: new Date(),
          payload: { completed_todo_id: todo.id, run_id: run.id },
        });
        queueContinuationScheduled = true;
      }
    }
    if (trigger.type === 'work_result') {
      const workOrderId = String(trigger.payload?.work_order_id || '');
      const order = workOrderId ? await prisma.hyperWorkOrder.findFirst({
        where: { id: workOrderId, orgId: runtime.orgId, runtimeEpoch: runtime.epoch, hqCycleId: { not: null } },
      }) : null;
      const result = order ? await prisma.hyperWorkResult.findFirst({
        where: { workOrderId: order.id, runtimeEpoch: runtime.epoch }, orderBy: { attempt: 'desc' },
      }) : null;
      const reviewSkill = this.skills.load('stage-review');
      await event(prisma, runtime, cycle, {
        eventType: 'skill_loaded', title: 'Specialist result review selected',
        summary: reviewSkill.description, skillRef: reviewSkill.id, workOrderId: order?.id || null,
      });
      const workResult = resolveWorkResultTodo({ order, result });
      if (!workResult) {
        await move('BLOCKED', { blockedReason: 'A Work Result event arrived without a durable result packet.' });
        await event(prisma, runtime, cycle, {
          eventType: 'blocked', title: 'Specialist result could not be reconciled',
          summary: 'HQ retained the event and stopped rather than inventing or replaying specialist work.',
          workOrderId: order?.id || null,
        });
        return { transition: 'ESCALATE', reason: 'work_result_missing' };
      }
      const { todoId, resultOutput } = workResult;
      const delivery = verifySpecialistDelivery({ order, result, resultOutput });
      const accepted = delivery.accepted;
      if (todoId) await prisma.hqTodo.updateMany({ where: { id: todoId, runtimeId: runtime.id }, data: accepted
        ? { status: 'COMPLETED', result: resultOutput, completedAt: new Date(), blockedReason: null }
        : { status: 'BLOCKED', result: resultOutput, blockedReason: delivery.failures.join(', ') } });
      if (order.growthDelegationId) await prisma.growthDelegation.updateMany({
        where: { id: order.growthDelegationId, orgId: runtime.orgId },
        data: accepted
          ? { status: 'COMPLETED', result: resultOutput, completedAt: new Date() }
          : { status: 'BLOCKED', result: { ...resultOutput, governance_failures: delivery.failures } },
      });
      await event(prisma, runtime, cycle, {
        eventType: 'verification',
        title: accepted ? 'Specialist result accepted' : 'Specialist result requires intervention',
        summary: accepted
          ? 'The bounded result is durable, attributable, evidence-linked, and ready to inform the active Growth Stage.'
          : `HQ rejected this as incomplete: ${delivery.failures.join('; ')}. The Work Order remains executable and will not be counted as completed.`,
        details: { status: result.status, attempt: result.attempt, usage: result.usage, governance_failures: delivery.failures },
        workOrderId: order.id, evidenceRefs: Array.isArray(result.evidence) ? result.evidence : [],
      });
      if (!accepted) {
        await scheduleHqWake({
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
          idempotencyKey: `queue-after-blocked:${order.id}`,
          triggerType: 'queue_advance', dueAt: new Date(),
          payload: { todo_id: todoId, rejected_work_order_id: order.id, governance_failures: delivery.failures },
        });
        await move('WAITING', { blockedReason: null, currentCycleId: null, nextWakeAt: new Date() });
        await event(prisma, runtime, cycle, {
          eventType: 'schedule_created', title: 'I retained the gap and advanced the queue',
          summary: 'The incomplete todo remains blocked with its exact governance gaps. I will not regenerate the same work. Another independent ready priority may proceed while this evidence gap remains visible.',
          details: { todo_id: todoId, rejected_work_order_id: order.id, governance_failures: delivery.failures },
          workOrderId: order.id,
        });
        return { transition: 'WAIT', reason: 'specialist_delivery_incomplete', failures: delivery.failures };
      }
      const dependents = todoId ? await prisma.hqTodo.findMany({
        where: {
          runtimeId: runtime.id, orgId: runtime.orgId, status: 'WAITING_FOR_DEPENDENCY',
          context: { path: ['depends_on_todo_id'], equals: todoId },
        },
        orderBy: [{ priority: 'asc' }, { position: 'asc' }],
      }) : [];
      const upstreamContract = resultOutput?.work_order_result && typeof resultOutput.work_order_result === 'object'
        ? resultOutput.work_order_result : null;
      for (const dependent of dependents) {
        await prisma.hqTodo.update({ where: { id: dependent.id }, data: {
          status: 'READY', blockedReason: null,
          context: {
            ...(dependent.context || {}), upstream_todo_id: todoId,
            upstream_work_order_id: order.id,
            upstream_result: upstreamContract ? {
              status: upstreamContract.status,
              deliverables: Array.isArray(upstreamContract.deliverables) ? upstreamContract.deliverables.slice(0, 20) : [],
              evidence_refs: Array.isArray(upstreamContract.evidence_refs) ? upstreamContract.evidence_refs.slice(0, 30) : [],
            } : { status: result.status, summary: result.summary },
          },
        } });
        await event(prisma, runtime, cycle, {
          eventType: 'todo_created', title: `Dependency satisfied: ${dependent.title}`,
          summary: `${dependent.title} is now executable with the accepted output from ${order.title}.`,
          details: { todo_id: dependent.id, depends_on_todo_id: todoId, upstream_work_order_id: order.id },
          workOrderId: order.id,
        });
      }
      if (dependents.length) {
        await scheduleHqWake({
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
          idempotencyKey: `dependency-ready:${order.id}`, triggerType: 'queue_advance', dueAt: new Date(),
          payload: { completed_todo_id: todoId, ready_todo_ids: dependents.map((row) => row.id) },
        });
        queueContinuationScheduled = true;
      }
      await event(prisma, runtime, cycle, {
        eventType: 'decision', title: 'Active Growth Stage continues with new evidence',
        summary: 'HQ accepted the specialist contribution and will compare stage outcomes at the next measurement checkpoint.',
        workOrderId: order.id,
      });
    } else if (readyTodo) {
      await move('DIAGNOSING');
      await move('DELEGATING');
      const skillId = 'specialist-delegation';
      const selectedSkill = this.skills.load(skillId);
      await event(prisma, runtime, cycle, { eventType: 'skill_loaded', title: `I am taking the next item: ${readyTodo.title}`, summary: selectedSkill.description, skillRef: skillId, details: { todo_id: readyTodo.id } });
      const rooms = await prisma.hyperRoom.findMany({ where: { orgId: runtime.orgId, archivedAt: null }, orderBy: { updatedAt: 'desc' } });
      const boundedObjective = specialistWorkObjective(readyTodo, skillId);
      const lifecycleContext = {
        company: context.company || {},
        target: {
          ...(readyTodo.context?.target || {}),
          ...(readyTodo.context?.location ? { location: readyTodo.context.location } : {}),
        },
        constraints: {
          authority_mode: readyTodo.context?.authority_mode === 'EXECUTE' ? 'EXECUTE' : 'PREPARE',
          acceptance_criteria: readyTodo.context?.acceptance_criteria || [],
          instruction_id: readyTodo.instructionId || null,
        },
      };
      const selectedLifecycle = this.runtimePlaybooks ? await this.runtimePlaybooks.selectAssignment({
        objective: boundedObjective, context: lifecycleContext,
      }).catch((error) => {
        this.logger.warn('[hq-runtime] playbook selection unavailable:', error.message);
        return null;
      }) : null;
      const declaredRoomTag = String(selectedLifecycle?.playbook?.metadata?.owner_room_tag || '').trim().toLowerCase();
      const roomTag = selectedLifecycle?.matched
        ? declaredRoomTag
        : await selectSpecialistRoomTag(readyTodo, skillId, rooms);
      const room = rooms.find((candidate) => candidate.roomTag === roomTag);
      if (!room) {
        await prisma.hqTodo.update({ where: { id: readyTodo.id }, data: { status: 'BLOCKED', blockedReason: `No ${roomTag} Company Room is available.` } });
        await event(prisma, runtime, cycle, { eventType: 'blocked', title: 'The right specialist room is unavailable', summary: `I retained the todo, but no ${roomTag} Company Room exists to own it. I will advance to another independent priority instead of substituting the wrong Room.`, details: { todo_id: readyTodo.id, required_room_tag: roomTag } });
        await scheduleHqWake({
          prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
          idempotencyKey: `queue-after-missing-room:${readyTodo.id}`,
          triggerType: 'queue_advance', dueAt: new Date(),
          payload: { todo_id: readyTodo.id, missing_room_tag: roomTag },
        });
      } else {
        const ownerId = room.permanentLeadId || room.participantIds?.[0] || null;
        const owner = ownerId ? await prisma.digitalEmployee.findUnique({ where: { id: ownerId } }) : null;
        const playbookAssignment = selectedLifecycle?.matched ? await this.runtimePlaybooks.createSelectedAssignment({
          orgId: runtime.orgId,
          roomId: room.id,
          objective: boundedObjective,
          idempotencyKey: `hq-todo:${runtime.epoch}:${readyTodo.id}`,
          trigger: {
            type: 'hq_todo',
            runtime_id: runtime.id,
            runtime_epoch: runtime.epoch,
            cycle_id: cycle.id,
            todo_id: readyTodo.id,
          },
          context: lifecycleContext,
          selection: selectedLifecycle.selection,
        }) : null;
        if (playbookAssignment?.matched) {
          await prisma.hqTodo.update({ where: { id: readyTodo.id }, data: { status: 'RUNNING', startedAt: new Date(), blockedReason: null } });
          await event(prisma, runtime, cycle, {
            eventType: 'work_order_created',
            title: `I started a checkpointed lifecycle: ${readyTodo.title}`,
            summary: `The ${roomTag} Room owns the current stage. HQ will advance only when the playbook predicates accept durable artifacts.`,
            details: {
              todo_id: readyTodo.id,
              room_id: room.id,
              room_tag: roomTag,
              runtime_playbook_run_id: playbookAssignment.run.id,
              playbook_id: playbookAssignment.selection.playbook_id,
              playbook_version: playbookAssignment.selection.version,
              selection_reason: playbookAssignment.selection.reason,
            },
          });
          const nextReady = capabilityState.todos.find((todo) => todo.id !== readyTodo.id && todo.status === 'READY');
          if (nextReady) {
            await scheduleHqWake({
              prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
              idempotencyKey: `queue-after-playbook-delegation:${playbookAssignment.run.id}`,
              triggerType: 'queue_advance', dueAt: new Date(),
              payload: { delegated_todo_id: readyTodo.id, next_todo_id: nextReady.id },
            });
            queueContinuationScheduled = true;
          }
        } else {
        const previousAttempts = await prisma.hyperWorkOrder.count({
          where: { orgId: runtime.orgId, inputSnapshot: { path: ['todo_id'], equals: readyTodo.id } },
        });
        const acceptanceCriteria = Array.isArray(readyTodo.context?.acceptance_criteria) && readyTodo.context.acceptance_criteria.length
          ? readyTodo.context.acceptance_criteria
          : ['Return a bounded result with evidence, next action, and measurable outcome.'];
        const { delegation, order } = await prisma.$transaction(async (tx) => {
          const delegation = runtime.activeStageId ? await tx.growthDelegation.create({ data: {
            orgId: runtime.orgId, growthStageId: runtime.activeStageId, roomId: room.id, roomTag,
            objective: boundedObjective,
            inputs: { todo_id: readyTodo.id, baseline_ref: context.evidence.baseline?.id, runtime_epoch: runtime.epoch },
            deliverable: boundedDelegationField(readyTodo.context?.deliverable),
            successMetric: boundedDelegationField(readyTodo.context?.success_measure || acceptanceCriteria.join('; ')),
            status: 'RUNNING',
          } }) : null;
          const order = await tx.hyperWorkOrder.create({ data: {
            orgId: runtime.orgId, roomId: room.id, hqCycleId: cycle.id, runtimeEpoch: runtime.epoch,
            orderKey: `todo-${readyTodo.id}`,
            growthDelegationId: delegation?.id || null,
            kind: readyTodo.kind, title: readyTodo.title, objective: boundedObjective,
            ownerEmployeeId: owner?.id || null, ownerSlug: owner?.slug || null, ownerLane: owner?.roleArchetype || null,
            // HQ chooses ownership and completion. The Room Director chooses its
            // own method skills and tools from the normal Room catalog.
            selectedSkills: [], requiredEvidence: ['company_memory', 'connected_capabilities'],
            acceptanceCriteria,
            inputSnapshot: {
              todo_id: readyTodo.id, location: readyTodo.context?.location, instruction_id: readyTodo.instructionId,
              workflow_id: readyTodo.context?.workflow_id || null,
              workflow_step_id: readyTodo.context?.workflow_step_id || null,
              workflow_step_key: readyTodo.context?.workflow_step_key || null,
              source_objective: readyTodo.objective,
              target: readyTodo.context?.target || {},
              completion_requirements: compileCompletionRequirements(readyTodo),
              upstream_result: readyTodo.context?.upstream_result || null,
              room_checkpoint: readyTodo.context?.room_checkpoint || null,
              room_checkpoint_fingerprint: readyTodo.context?.room_checkpoint_fingerprint || null,
              room_tag: roomTag,
              authority: {
                mode: readyTodo.context?.authority_mode === 'EXECUTE' ? 'EXECUTE' : 'PREPARE',
                vision: 'semantic_only', hands: readyTodo.context?.authority_mode === 'EXECUTE' ? 'governed_external_writes' : 'internal_writes',
                external_writes: readyTodo.context?.authority_mode === 'EXECUTE', spending: false, resumable: true,
              },
              runtime_epoch: runtime.epoch,
            },
            evidenceRefs: [context.evidence.baseline?.id].filter(Boolean),
            attempt: previousAttempts,
          } });
          await tx.hqTodo.update({ where: { id: readyTodo.id }, data: { status: 'RUNNING', startedAt: new Date() } });
          if (readyTodo.context?.workflow_step_id) await tx.hqWorkflowStep.updateMany({ where: {
            id: readyTodo.context.workflow_step_id, workflowId: readyTodo.context.workflow_id || undefined,
            orgId: runtime.orgId, status: { in: ['READY', 'PENDING'] },
          }, data: { status: 'RUNNING', workOrderId: order.id, startedAt: new Date(), blockedReason: null } });
          if (readyTodo.context?.workflow_id) await tx.hqWorkflow.updateMany({ where: {
            id: readyTodo.context.workflow_id, orgId: runtime.orgId, status: { in: ['READY', 'WAITING'] },
          }, data: { status: 'RUNNING', startedAt: new Date(), terminalReason: null } });
          return { delegation, order };
        });
        const authorityMode = order.inputSnapshot?.authority?.mode || 'PREPARE';
        await event(prisma, runtime, cycle, { eventType: 'work_order_created', title: `I delegated: ${readyTodo.title}`, summary: authorityMode === 'EXECUTE'
          ? `The ${roomTag} specialist owns this bounded action in EXECUTE mode. Every external action must pass the existing connector authorization and approval policy, and completion requires durable provider receipts.`
          : `The ${roomTag} specialist owns this bounded action in PREPARE mode. It may read evidence and persist internal deliverables, but it may not send, publish, spend, or change company policy. I will verify ${acceptanceCriteria.length} explicit completion ${acceptanceCriteria.length === 1 ? 'criterion' : 'criteria'} before advancing it.`, workOrderId: order.id, details: { todo_id: readyTodo.id, room_id: room.id, room_tag: roomTag, candidate_room_tags: rooms.map((candidate) => candidate.roomTag), routing: 'required_owner', authority: order.inputSnapshot?.authority, completion_requirements: order.inputSnapshot?.completion_requirements, acceptance_criteria: acceptanceCriteria } });
        const nextReady = capabilityState.todos.find((todo) => todo.id !== readyTodo.id && todo.status === 'READY');
        if (nextReady) {
          await scheduleHqWake({
            prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
            idempotencyKey: `queue-after-delegation:${order.id}`,
            triggerType: 'queue_advance', dueAt: new Date(),
            payload: { delegated_todo_id: readyTodo.id, next_todo_id: nextReady.id },
          });
          queueContinuationScheduled = true;
          await event(prisma, runtime, cycle, {
            eventType: 'schedule_created', title: 'I am continuing with independent work',
            summary: `${readyTodo.title} remains tracked by its specialist. I am moving immediately to ${nextReady.title} instead of idling while the first result is in flight.`,
            details: { delegated_todo_id: readyTodo.id, next_todo_id: nextReady.id }, workOrderId: order.id,
          });
        }
        }
      }
    } else if (!context.evidence.latest_growth_plan) {
      await move('DIAGNOSING');
      const selectedSkill = this.skills.load('growth-constraint-diagnosis');
      const [growthToolkit] = this.toolkits.select(['growth_plan']);
      const selectedModel = selectedSkill.model_policy?.model || 'gpt-oss-120b';
      await event(prisma, runtime, cycle, { eventType: 'skill_loaded', title: 'I am ranking the company constraints', summary: `${selectedSkill.description} I will compare the complete company state, preserve material unknowns, and order only the work justified by evidence and the operating requirements.`, skillRef: selectedSkill.id, details: { model_policy: selectedSkill.model_policy, selected_model: selectedModel } });
      await event(prisma, runtime, cycle, { eventType: 'tool_started', title: 'I am building the first Growth Operating Plan', summary: 'I will assess the complete baseline, rank multiple constraints, define the first bounded stage, and commit an ordered specialist todo queue before dispatching any work.', toolRef: 'growth_plan_run', details: { toolkit: growthToolkit.id, model: selectedModel, mode: 'initial_full' } });
      const planningRequirements = appliedInstructions.map((item) => item.instruction.body).filter(Boolean);
      const result = await this.toolkits.invoke('growth_plan', 'run', {
        mode: 'initial_full', objective: [runtime.objective, ...planningRequirements].filter(Boolean).join('\n\nOperating requirement:\n'), hqCycleId: cycle.id,
        model: selectedModel,
        onProgress: async ({ stage, detail }) => event(prisma, runtime, cycle, {
          eventType: 'observation',
          title: stage === 'context' ? 'I loaded the evidence for this decision' : stage === 'planning' ? 'I am comparing the company as a whole' : stage === 'governance' ? 'I am checking whether this plan can actually operate' : 'I am committing the chosen next move',
          summary: detail,
          details: { growth_plan_stage: stage },
        }),
      }, { prisma, orgId: runtime.orgId, userId: runtime.ownerUserId });
      const acknowledged = summarizeGrowthPlanResult(result);
      await event(prisma, runtime, cycle, {
        eventType: 'tool_result', title: 'I have a governed operating plan',
        summary: acknowledged.summary,
        toolRef: 'growth_plan_run', evidenceRefs: [result.artifact_id],
        details: { toolkit: growthToolkit.id, model: result.model, usage: result.usage || {}, ...acknowledged.details },
      });
      await move('DELEGATING', { activeGoalId: result.committed.goal_id, activeStageId: result.committed.stage_id });
      await event(prisma, runtime, cycle, {
        eventType: 'decision', title: 'I selected the first bounded Growth Stage',
        summary: result.plan?.stage?.objective || result.plan?.executive_thesis || 'The initial Growth Stage is ready.',
        details: { constraints: result.plan?.constraints, stage: result.plan?.stage }, evidenceRefs: [result.artifact_id],
      });
      await event(prisma, runtime, cycle, {
        eventType: 'todo_created', title: 'I committed the first operating queue',
        summary: `${(result.plan?.operating_queue || []).map((item, index) => `${index + 1}. ${item.title}`).join('; ')}. I will take the first executable item; a waiting item will remain visible while the next independent ready item advances.`,
        details: { todo_ids: result.committed?.todo_ids || [], operating_queue: result.plan?.operating_queue || [] }, evidenceRefs: [result.artifact_id],
      });
      await scheduleHqWake({
        prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
        idempotencyKey: `initial-plan-queue:${result.artifact_id}`,
        triggerType: 'queue_advance', dueAt: new Date(), payload: { growth_plan_id: result.artifact_id },
      });
    } else {
      await move('DIAGNOSING');
      const action = context.growth.next_action;
      await event(prisma, runtime, cycle, {
        eventType: 'decision', title: `Next operating action: ${action.action}`,
        summary: action.reason, details: { priority: action.priority },
        evidenceRefs: [context.evidence.baseline.id, context.evidence.latest_growth_plan.id],
      });
      if (trigger.type === 'user_wake' && action.action === 'monitor' && !appliedInstructions.length) {
        await event(prisma, runtime, cycle, { eventType: 'observation', title: 'No material change detected', summary: 'The company state, operating instruction, work ownership, and measurement evidence are unchanged. Repeating the same work would create activity, not progress.' });
      }
    }

    if (['work_result', 'runtime_playbook_result'].includes(trigger.type) && capabilityState.todos.some((todo) => todo.status === 'READY')) {
      await scheduleHqWake({
        prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
        idempotencyKey: `queue-advance:${cycle.id}`, triggerType: 'queue_advance', dueAt: new Date(),
        payload: { completed_cycle_id: cycle.id },
      });
    }

    const dueAt = context.growth.active_stage?.checkpoint_at
      ? new Date(context.growth.active_stage.checkpoint_at)
      : new Date(Date.now() + DAY);
    await scheduleHqWake({
      prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
      idempotencyKey: `checkpoint:${runtime.activeStageId || cycle.id}:${dueAt.toISOString()}`,
      triggerType: 'checkpoint', dueAt, payload: { stage_id: runtime.activeStageId },
    });
    const measurement = context.growth.active_stage?.measurement || {};
    const metrics = [...new Set([...(measurement.primary_metrics || []), ...(measurement.metrics || []), ...Object.keys(measurement.thresholds || {})])].slice(0, 6);
    const waitingDays = Math.max(1, Math.ceil((dueAt.getTime() - Date.now()) / DAY));
    const openCapability = capabilityState.requests[0];
    const [pendingLegacySpecialist, pendingPlaybookRun] = await Promise.all([
      prisma.hyperWorkOrder.findFirst({
        where: { orgId: runtime.orgId, runtimeEpoch: runtime.epoch, hqCycleId: { not: null }, status: { in: ['queued', 'running', 'processing'] } },
        select: { title: true, status: true },
      }),
      prisma.runtimePlaybookRun?.findFirst ? prisma.runtimePlaybookRun.findFirst({
        where: { orgId: runtime.orgId, status: 'ACTIVE' },
        orderBy: { updatedAt: 'asc' }, select: { id: true, currentStageId: true, status: true },
      }).catch(() => null) : Promise.resolve(null),
    ]);
    const pendingSpecialist = pendingLegacySpecialist || (pendingPlaybookRun ? {
      title: `stage ${pendingPlaybookRun.currentStageId}`, status: pendingPlaybookRun.status,
    } : null);
    const sleepReason = queueContinuationScheduled
      ? 'The next independent todo is already scheduled for immediate dispatch. I am retaining every in-flight assignment and will reconcile each result when it returns.'
      : openCapability
      ? `I am pausing because ${openCapability.provider} is not connected. That capability is required by the next todo; pretending otherwise would produce an unusable result. Connect it and I will wake immediately, verify the tenant binding, and continue the same todo.`
      : pendingSpecialist
        ? `I am waiting for the specialist working on ${pendingSpecialist.title}. Its result, a connector failure, or a new instruction will wake me immediately. The ${waitingDays}-day checkpoint is only the next measurement review; it is not a delay before I can continue.`
      : `I am sleeping because assigned work is owned and no material evidence has changed. The next useful decision needs about ${waitingDays} day(s) of observation${metrics.length ? ` across ${metrics.join(', ')}` : ''}. I will wake at ${dueAt.toISOString()} to compare results with the active stage thresholds. I will wake earlier for a campaign result, connector change or failure, specialist result, new instruction, or material performance change.`;
    await event(prisma, runtime, cycle, { eventType: 'schedule_created', title: 'I scheduled the next checkpoint', summary: `The next evidence review is ${dueAt.toISOString()}. Its timing comes from the active Growth Stage, not an arbitrary sleep interval.`, details: { wake_reasons: ['checkpoint', 'work_result', 'instruction_updated', 'connector_changed', 'material_evidence'], metrics } });
    await move('WAITING', { nextWakeAt: dueAt, currentCycleId: null });
    await event(prisma, runtime, cycle, { eventType: queueContinuationScheduled ? 'observation' : 'sleep', title: queueContinuationScheduled ? 'The queue is still moving' : openCapability ? 'I am waiting for access' : pendingSpecialist ? 'I am waiting for specialist work' : 'I am sleeping', summary: sleepReason, details: { due_at: dueAt.toISOString(), capability_request_id: openCapability?.id || null, pending_specialist: pendingSpecialist } });
    return { transition: 'WAIT', nextWakeAt: dueAt };
  }
}

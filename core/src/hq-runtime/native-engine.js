import { appendHqEvent, scheduleHqWake, transitionHqRuntime } from './repository.js';
import { buildHqContext } from './context.js';
import { HqSkillRegistry, HqToolkitRegistry } from './skill-registry.js';
import { ingestPendingInstructions, reconcileTodoCapabilities } from './instruction-loop.js';
import { narrateAwakening } from './awakening-narrator.js';

const DAY = 86400000;

const metric = (value) => Number(value || 0).toLocaleString('en-US');

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

export function specialistWorkObjective(todo, skillId) {
  return String(todo?.objective || todo?.title || '').trim();
}

export function compactCompanyOperatingContext(company = {}) {
  const profile = company.profile && typeof company.profile === 'object' ? company.profile : {};
  return {
    name: company.company || company.name || profile.name || null,
    website: company.website || profile.website || null,
    location: company.company_location || profile.location || company.location || null,
    mission: company.mission || profile.mission || null,
    profile: {
      industry: profile.industry || null,
      business_model: profile.business_model || null,
      offer: profile.offer || null,
      icp: profile.icp || null,
      positioning: profile.positioning || null,
      capabilities: Array.isArray(profile.capabilities) ? profile.capabilities.slice(0, 20) : [],
      risks: Array.isArray(profile.risks) ? profile.risks.slice(0, 12) : [],
    },
  };
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
    const focusedOutcome = capabilityState.todos.find((todo) => (
      todo.context?.execution_mode === 'single_outcome' && todo.status !== 'COMPLETED'
    ));
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
      } else if (run.status === 'WAITING_EVENT') {
        await prisma.hqTodo.update({ where: { id: todo.id }, data: {
          status: 'RUNNING', blockedReason: null,
          result: {
            runtime_playbook_run_id: run.id,
            playbook_id: run.playbookId,
            playbook_version: run.playbookVersion,
            status: run.status,
            waiting_for: run.waitingFor || {},
            artifact_refs: artifactRefs,
          },
        } });
        await event(prisma, runtime, cycle, {
          eventType: 'observation', title: `Response monitoring is active: ${todo.title}`,
          summary: `The lifecycle completed ${run.completedStageIds.length} checkpointed stage(s) and retained ${artifactRefs.length} durable artifact(s). Provider response correlation is active; a matching event will resume this same run immediately.`,
          details: { run_id: run.id, waiting_for: run.waitingFor || {}, artifact_refs: artifactRefs },
          evidenceRefs: artifactRefs,
        });
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
        company: compactCompanyOperatingContext(context.company),
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
      let selectionError = null;
      const selectedLifecycle = this.runtimePlaybooks ? await this.runtimePlaybooks.selectAssignment({
        objective: boundedObjective, context: lifecycleContext,
      }).catch((error) => {
        selectionError = error;
        this.logger.warn('[hq-runtime] playbook selection unavailable:', error.message);
        return null;
      }) : null;
      if (!selectedLifecycle?.matched) {
        const reason = selectionError
          ? `Playbook selection failed: ${String(selectionError.message || selectionError).slice(0, 1000)}`
          : String(selectedLifecycle?.selection?.reason || 'No installed lifecycle fits this bounded assignment.').slice(0, 1000);
        await prisma.hqTodo.update({
          where: { id: readyTodo.id },
          data: { status: 'BLOCKED', blockedReason: reason },
        });
        await event(prisma, runtime, cycle, {
          eventType: 'blocked',
          title: 'No checkpointed lifecycle is installed for this work',
          summary: `${reason} I retained the todo and will advance another independent priority instead of bypassing artifact governance with a one-shot Room run.`,
          details: {
            todo_id: readyTodo.id,
            selection_reason: selectedLifecycle?.selection?.reason || null,
            selector_error: selectionError ? String(selectionError.message || selectionError).slice(0, 1000) : null,
          },
        });
        const anotherReady = capabilityState.todos.some((todo) => todo.id !== readyTodo.id && todo.status === 'READY');
        if (anotherReady) {
          await scheduleHqWake({
            prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
            idempotencyKey: `queue-after-missing-playbook:${readyTodo.id}`,
            triggerType: 'queue_advance', dueAt: new Date(),
            payload: { todo_id: readyTodo.id, reason: 'playbook_unavailable' },
          });
          queueContinuationScheduled = true;
        }
      } else {
        const roomTag = String(selectedLifecycle.playbook.metadata?.owner_room_tag || '').trim().toLowerCase();
        const room = rooms.find((candidate) => candidate.roomTag === roomTag);
        if (!room) {
          await prisma.hqTodo.update({ where: { id: readyTodo.id }, data: { status: 'BLOCKED', blockedReason: `No ${roomTag} Company Room is available.` } });
          await event(prisma, runtime, cycle, { eventType: 'blocked', title: 'The right specialist room is unavailable', summary: `I retained the todo, but no ${roomTag} Company Room exists to own it. I will advance to another independent priority instead of substituting the wrong Room.`, details: { todo_id: readyTodo.id, required_room_tag: roomTag } });
          const anotherReady = capabilityState.todos.some((todo) => todo.id !== readyTodo.id && todo.status === 'READY');
          if (anotherReady) {
            await scheduleHqWake({
              prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
              idempotencyKey: `queue-after-missing-room:${readyTodo.id}`,
              triggerType: 'queue_advance', dueAt: new Date(),
              payload: { todo_id: readyTodo.id, missing_room_tag: roomTag },
            });
            queueContinuationScheduled = true;
          }
        } else {
          const playbookAssignment = await this.runtimePlaybooks.createSelectedAssignment({
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
          });
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
        }
      }
    } else if (!context.evidence.latest_growth_plan && !focusedOutcome) {
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
    } else if (focusedOutcome) {
      await event(prisma, runtime, cycle, {
        eventType: 'observation', title: 'The focused outcome remains retained',
        summary: 'The single requested outcome has not reached a terminal lifecycle state. I will not replace it with a broader operating plan.',
        details: { todo_id: focusedOutcome.id, todo_status: focusedOutcome.status },
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

    const stageCheckpoint = context.growth.active_stage?.checkpoint_at
      ? new Date(context.growth.active_stage.checkpoint_at) : null;
    const dueAt = stageCheckpoint && Number.isFinite(stageCheckpoint.getTime()) ? stageCheckpoint : null;
    if (dueAt) await scheduleHqWake({
      prisma, runtimeId: runtime.id, orgId: runtime.orgId, runtimeEpoch: runtime.epoch,
      idempotencyKey: `checkpoint:${runtime.activeStageId}:${dueAt.toISOString()}`,
      triggerType: 'checkpoint', dueAt, payload: { stage_id: runtime.activeStageId },
    });
    const measurement = context.growth.active_stage?.measurement || {};
    const metrics = [...new Set([...(measurement.primary_metrics || []), ...(measurement.metrics || []), ...Object.keys(measurement.thresholds || {})])].slice(0, 6);
    const waitingDays = dueAt ? Math.max(1, Math.ceil((dueAt.getTime() - Date.now()) / DAY)) : null;
    const openCapability = capabilityState.requests[0];
    const [pendingLegacySpecialist, pendingPlaybookRun] = await Promise.all([
      prisma.hyperWorkOrder.findFirst({
        where: { orgId: runtime.orgId, runtimeEpoch: runtime.epoch, hqCycleId: { not: null }, status: { in: ['queued', 'running', 'processing'] } },
        select: { title: true, status: true },
      }),
      prisma.runtimePlaybookRun?.findFirst ? prisma.runtimePlaybookRun.findFirst({
        where: { orgId: runtime.orgId, status: { in: ['ACTIVE', 'WAITING_EVENT', 'WAITING_AUTHORITY'] } },
        orderBy: { updatedAt: 'asc' }, select: { id: true, currentStageId: true, status: true },
      }).catch(() => null) : Promise.resolve(null),
    ]);
    const pendingSpecialist = pendingLegacySpecialist || (pendingPlaybookRun ? {
      title: `stage ${pendingPlaybookRun.currentStageId}`, status: pendingPlaybookRun.status,
    } : null);
    const blockedTodos = capabilityState.todos.filter((todo) => todo.status === 'BLOCKED');
    const waitingForResponse = pendingPlaybookRun?.status === 'WAITING_EVENT';
    const sleepReason = queueContinuationScheduled
      ? 'The next independent todo is already scheduled for immediate dispatch. I am retaining every in-flight assignment and will reconcile each result when it returns.'
      : openCapability
      ? `I am pausing because ${openCapability.provider} is not connected. That capability is required by the next todo; pretending otherwise would produce an unusable result. Connect it and I will wake immediately, verify the tenant binding, and continue the same todo.`
      : waitingForResponse
        ? 'I am watching the accepted provider correlations for matching responses. The configured monitor resumes this exact checkpoint when an event arrives; there is no arbitrary measurement delay.'
      : pendingSpecialist
        ? `I am waiting for the specialist working on ${pendingSpecialist.title}. Its result, a connector failure, or a new instruction will wake me immediately.`
      : blockedTodos.length
        ? `${blockedTodos.length} retained todo(s) cannot advance because their exact lifecycle or owner is unavailable. No work is running, and I will not describe this as observation or completed activity.`
      : dueAt
        ? `I am sleeping because the active stage now needs ${waitingDays} day(s) of measured observation${metrics.length ? ` across ${metrics.join(', ')}` : ''}. I will wake at ${dueAt.toISOString()} or earlier for material evidence.`
      : 'No executable or in-flight work remains. I will wake for a new instruction, connector event, or durable result.';
    if (dueAt) await event(prisma, runtime, cycle, { eventType: 'schedule_created', title: 'I scheduled the next measurement checkpoint', summary: `The next evidence review is ${dueAt.toISOString()} because the active Growth Stage declares that checkpoint.`, details: { wake_reasons: ['checkpoint', 'work_result', 'instruction_updated', 'connector_changed', 'material_evidence'], metrics } });
    await move('WAITING', { nextWakeAt: dueAt, currentCycleId: null });
    const waitingTitle = queueContinuationScheduled ? 'The queue is still moving'
      : openCapability ? 'I am waiting for access'
      : waitingForResponse ? 'I am monitoring for replies'
      : pendingSpecialist ? 'I am waiting for specialist work'
      : blockedTodos.length ? 'The operating queue needs intervention' : 'I am sleeping';
    await event(prisma, runtime, cycle, { eventType: queueContinuationScheduled || waitingForResponse ? 'observation' : blockedTodos.length ? 'blocked' : 'sleep', title: waitingTitle, summary: sleepReason, details: { due_at: dueAt?.toISOString() || null, capability_request_id: openCapability?.id || null, pending_specialist: pendingSpecialist, blocked_todo_ids: blockedTodos.map((todo) => todo.id) } });
    return { transition: 'WAIT', nextWakeAt: dueAt };
  }
}

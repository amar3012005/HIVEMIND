import { loadFirstLifePolicy } from '../growth/first-life-policy.js';
import { projectRuntimePlaybookSnapshot, terminalOutcomeSatisfied } from '../runtime-playbooks/snapshot.js';
import { resolveAuthorityPreference } from './contracts.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function effectClass(todo) {
  const context = asObject(todo.context);
  return context.effect_class === 'external' || context.external_action_requested === true
    ? 'external' : 'internal';
}

function bootstrapIdentity(policy, runtime) {
  return `${policy.policy_id}.v${policy.version}:${runtime.epoch}:bootstrap`;
}

export async function ensureFirstLifeBootstrapProposal({ prisma, runtime, policy, registry, company, baseline,
  adminCurrentStatus = null, connectedCapabilities = [], instruction = '' }) {
  const configured = asObject(policy?.initial_lifecycle);
  if (configured.bypass_growth_plan !== true) return { todo: null, created: false, reason: 'policy_does_not_bypass_growth_plan' };
  const playbookId = String(configured.playbook_id || '').trim();
  const playbookVersion = Number(configured.version);
  const requestedAction = String(configured.supported_action || '').trim();
  if (!playbookId || !Number.isInteger(playbookVersion) || !requestedAction) {
    throw new Error('first_life_initial_lifecycle_invalid');
  }
  if (!registry) throw new Error('first_life_playbook_registry_unavailable');
  const playbook = registry.get(playbookId, playbookVersion, { scopeKey: 'global' });
  const supportedActions = Array.isArray(playbook.metadata?.supported_actions)
    ? playbook.metadata.supported_actions.map(String) : [];
  const roomTag = String(playbook.metadata?.owner_room_tag || '').trim().toLowerCase();
  if (!supportedActions.includes(requestedAction) || !roomTag) {
    throw new Error('first_life_initial_lifecycle_incompatible');
  }
  if (playbook.metadata?.effect_class !== 'internal'
    || (playbook.stages || []).some((stage) => stage.authority_gate)) {
    throw new Error('first_life_initial_lifecycle_must_be_internal');
  }
  const key = bootstrapIdentity(policy, runtime);
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRawUnsafe(
      `SELECT id, epoch FROM hivemind.hq_runtimes
        WHERE id=$1::uuid AND org_id=$2::uuid AND epoch=$3::uuid FOR UPDATE`,
      runtime.id, runtime.orgId, runtime.epoch,
    );
    if (!locked.length) throw new Error('first_life_runtime_epoch_conflict');
    let todo = await tx.hqTodo.findFirst({
      where: { runtimeId: runtime.id, orgId: runtime.orgId, context: { path: ['first_life_bootstrap_key'], equals: key } },
    });
    if (todo) return { todo, created: false, reason: 'already_exists' };
    const room = await tx.hyperRoom.findFirst({
      where: { orgId: runtime.orgId, archivedAt: null, roomTag }, select: { id: true },
    });
    if (!room) throw new Error(`first_life_initial_room_unavailable:${roomTag}`);
    const baselineRef = String(baseline?.id || baseline?.resource_id || '').trim() || null;
    const adminRef = String(adminCurrentStatus?.artifactId || adminCurrentStatus?.artifact_id || '').trim() || null;
    todo = await tx.hqTodo.create({ data: {
      runtimeId: runtime.id,
      orgId: runtime.orgId,
      title: String(playbook.name || playbook.description || requestedAction).slice(0, 240),
      objective: String(playbook.description || playbook.name || requestedAction),
      kind: roomTag.slice(0, 60),
      status: 'PROPOSED',
      priority: 0,
      position: 0,
      requiredCapabilities: [],
      context: {
        first_life_bootstrap_key: key,
        runtime_epoch: runtime.epoch,
        proposal_origin: 'first_life_bootstrap',
        first_life_policy_id: policy.policy_id,
        first_life_policy_version: policy.version,
        activation_sprint_id: key,
        recommendation_rank: 1,
        recommended: true,
        room_tag: roomTag,
        effect_class: 'internal',
        external_action_requested: false,
        planned_playbook_id: playbookId,
        planned_playbook_version: playbookVersion,
        requested_action: requestedAction,
        requested_terminal_outcome: String(playbook.metadata?.terminal_states_by_action?.[requestedAction]?.[0]
          || playbook.terminal_states?.[0] || requestedAction),
        source_instruction: String(instruction || runtime.objective || ''),
        execution_mode: 'first_life_bootstrap',
        baseline_ref: baselineRef,
        admin_current_status_ref: adminRef,
        evidence_refs: [baselineRef, adminRef].filter(Boolean),
        company_context: asObject(company),
        connected_capabilities: Array.isArray(connectedCapabilities) ? connectedCapabilities : [],
      },
    } });
    return { todo, created: true, reason: 'created' };
  });
}

export async function projectFirstLifeOperatingGate({ prisma, runtime }) {
  const todos = await prisma.hqTodo.findMany({
    where: { runtimeId: runtime.id, orgId: runtime.orgId, status: { notIn: ['CANCELLED'] } },
    orderBy: [{ createdAt: 'asc' }, { priority: 'asc' }],
  });
  const current = todos.filter((todo) => String(asObject(todo.context).runtime_epoch || '') === String(runtime.epoch || ''));
  const bootstrap = current.find((todo) => asObject(todo.context).proposal_origin === 'first_life_bootstrap') || null;
  const motions = current.filter((todo) => asObject(todo.context).proposal_origin === 'strategy_program');
  const terminal = new Set(['COMPLETED', 'CANCELLED']);
  return {
    bootstrap,
    motions,
    bootstrap_complete: bootstrap?.status === 'COMPLETED',
    motions_materialized: motions.length > 0,
    motions_complete: motions.length > 0 && motions.every((todo) => terminal.has(String(todo.status).toUpperCase())),
  };
}

function projectedStatus(todo, run) {
  const runStatus = String(run?.status || '').toUpperCase();
  if (runStatus === 'WAITING_AUTHORITY') return 'WAITING_FOR_AUTHORITY';
  if (runStatus === 'WAITING_EVENT') {
    return (run?.waitingFor?.types || []).includes('capability.connected')
      ? 'WAITING_FOR_CONNECTOR' : 'MONITORING';
  }
  if (runStatus === 'COMPLETED') return terminalOutcomeSatisfied(run) ? 'COMPLETED' : 'NEEDS_ATTENTION';
  if (['NEEDS_INTERVENTION', 'TERMINATED'].includes(runStatus) || todo.status === 'BLOCKED') return 'NEEDS_ATTENTION';
  if (run) return 'RUNNING';
  return String(todo.status || 'PROPOSED').toUpperCase();
}

export async function projectCurrentFirstLife({ prisma, orgId }) {
  const [todos, runtime] = await Promise.all([
    prisma.hqTodo.findMany({
      where: { orgId, status: { notIn: ['CANCELLED'] } },
      orderBy: [{ createdAt: 'desc' }, { priority: 'asc' }, { position: 'asc' }],
      take: 100,
    }),
    prisma.hqRuntime.findUnique({ where: { orgId }, select: { id: true, epoch: true, authorityPolicy: true } }),
  ]);
  if (!runtime) return null;
  const proposals = todos.filter((todo) => {
    const context = asObject(todo.context);
    return todo.runtimeId === runtime.id
      && context.first_life_policy_id === 'runtime.first-life-policy'
      && Number(context.first_life_policy_version) > 0
      && String(context.runtime_epoch || '') === String(runtime.epoch || '');
  });
  if (!proposals.length) return null;
  const firstLifeId = asObject(proposals[0].context).activation_sprint_id;
  const scoped = proposals.filter((todo) => asObject(todo.context).activation_sprint_id === firstLifeId);
  const policyVersion = Number(asObject(scoped[0]?.context).first_life_policy_version);
  const policy = await loadFirstLifePolicy(policyVersion);
  const todoIds = scoped.map((todo) => todo.id);
  const runs = await prisma.runtimePlaybookRun.findMany({
    where: { orgId },
    include: {
      artifacts: { orderBy: { createdAt: 'asc' } },
      checkpoints: { orderBy: { sequence: 'desc' }, take: 1 },
      authorities: true,
    },
    orderBy: { updatedAt: 'desc' },
    take: 100,
  });
  const runByTodo = new Map();
  for (const run of runs) {
    const todoId = String(asObject(run.trigger).todo_id || '');
    if (todoIds.includes(todoId) && !runByTodo.has(todoId)) runByTodo.set(todoId, run);
  }
  const items = scoped.map((todo) => {
    const run = runByTodo.get(todo.id) || null;
    const context = asObject(todo.context);
    const evidenceRefs = Array.isArray(context.evidence_refs)
      ? context.evidence_refs
      : context.baseline_ref ? [context.baseline_ref] : [];
    return {
      todo_id: todo.id,
      title: todo.title,
      objective: todo.objective,
      room_tag: context.room_tag || todo.kind,
      recommendation_rank: Number(context.recommendation_rank || todo.position + 1),
      recommended: context.recommended === true,
      effect_class: effectClass(todo),
      response_locale: context.response_locale || null,
      requested_outcome: context.requested_terminal_outcome || context.requested_action || null,
      evidence_refs: evidenceRefs,
      status: projectedStatus(todo, run),
      execution: run ? projectRuntimePlaybookSnapshot(run) : null,
    };
  });
  const activeStatuses = new Set([
    'READY', 'RUNNING', 'WAITING_FOR_CONNECTOR', 'WAITING_FOR_AUTHORITY', 'MONITORING',
  ]);
  const activeExternal = scoped.filter((todo) => {
    const item = items.find((candidate) => candidate.todo_id === todo.id);
    return item?.effect_class === 'external' && activeStatuses.has(item.status)
      && asObject(todo.context).execution_slot_released !== true;
  }).length;
  const activeInternal = items.filter((item) => item.effect_class === 'internal' && activeStatuses.has(item.status)).length;
  const started = scoped.some((todo) => asObject(todo.context).first_life_started === true)
    || items.some((item) => item.status !== 'PROPOSED');
  const reviewedLater = scoped.some((todo) => asObject(todo.context).first_life_reviewed_later === true);
  const awaitingStart = Boolean(policy.require_initial_start_decision || policy.require_initial_policy_choice) && !started;
  const proposed = items.filter((item) => item.status === 'PROPOSED');
  const needsAttention = items.some((item) => item.status === 'NEEDS_ATTENTION');
  const operating = items.some((item) => ['RUNNING', 'MONITORING', 'WAITING_FOR_AUTHORITY', 'WAITING_FOR_CONNECTOR'].includes(item.status));
  const responseLocale = items.find((item) => item.response_locale)?.response_locale || null;
  return {
    id: firstLifeId,
    policy: { id: policy.policy_id, version: policy.version },
    status: awaitingStart ? (reviewedLater ? 'REVIEW_LATER' : 'AWAITING_START')
      : operating ? 'OPERATING'
        : proposed.length ? 'READY' : needsAttention ? 'NEEDS_ATTENTION' : 'COMPLETED',
    recommended_todo_id: items.find((item) => item.recommended)?.todo_id || items[0]?.todo_id || null,
    proposal_count: items.length,
    proposed_count: proposed.length,
    completed_count: items.filter((item) => item.status === 'COMPLETED').length,
    response_locale: responseLocale,
    active_external_count: activeExternal,
    active_internal_count: activeInternal,
    capacity: {
      external: Number(policy.external_execution_limit || 1),
      internal: Number(policy.internal_execution_limit || 1),
    },
    waiting_reason: awaitingStart ? (reviewedLater ? 'user_deferred_start' : 'initial_start_decision') : null,
    items,
  };
}

export async function activateEligibleFirstLifeWork({ prisma, runtime, expansionTrigger, proposalOrigin = null }) {
  const currentPolicy = await loadFirstLifePolicy();
  if (!currentPolicy.expansion_triggers.includes(expansionTrigger)) return { promoted: [], reason: 'trigger_not_allowed' };
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRawUnsafe(
      `SELECT id, authority_policy
         FROM hivemind.hq_runtimes
        WHERE id=$1::uuid AND org_id=$2::uuid AND epoch=$3::uuid
        FOR UPDATE`,
      runtime.id, runtime.orgId, runtime.epoch,
    );
    if (!locked.length) throw new Error('first_life_runtime_epoch_conflict');
    const authorityPolicy = asObject(locked[0].authority_policy);
    const policyConfigured = resolveAuthorityPreference(authorityPolicy, null) !== 'unconfigured';

    const todos = await tx.hqTodo.findMany({
      where: { runtimeId: runtime.id, orgId: runtime.orgId, status: { notIn: ['CANCELLED'] } },
      orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    });
    const todoIds = todos.map((todo) => todo.id);
    const runs = todoIds.length ? await tx.runtimePlaybookRun.findMany({
      where: { orgId: runtime.orgId },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, status: true, waitingFor: true, trigger: true },
    }) : [];
    const runByTodo = new Map();
    for (const run of runs) {
      const todoId = String(asObject(run.trigger).todo_id || '');
      if (todoIds.includes(todoId) && !runByTodo.has(todoId)) runByTodo.set(todoId, run);
    }
    const firstLifeCandidates = todos.filter((todo) => {
      const context = asObject(todo.context);
      return context.first_life_policy_id === currentPolicy.policy_id
        && Number(context.first_life_policy_version) > 0
        && String(context.runtime_epoch || '') === String(runtime.epoch || '');
    });
    const firstLifeId = asObject(firstLifeCandidates[0]?.context).activation_sprint_id || null;
    const firstLifeProposals = firstLifeId
      ? firstLifeCandidates.filter((todo) => asObject(todo.context).activation_sprint_id === firstLifeId)
      : firstLifeCandidates;
    const policy = firstLifeProposals.length
      ? await loadFirstLifePolicy(Number(asObject(firstLifeProposals[0].context).first_life_policy_version))
      : currentPolicy;
    if (!policy.expansion_triggers.includes(expansionTrigger)) return { promoted: [], reason: 'trigger_not_allowed' };
    const directProposals = todos.filter((todo) => asObject(todo.context).proposal_origin === 'user_instruction');
    const strategyProposals = todos.filter((todo) => asObject(todo.context).proposal_origin === 'strategy_program');
    const autoPlanProposal = policy.auto_start_initial_plan === true
      && ['initial_plan_ready', 'verified_result'].includes(expansionTrigger);
    const proposals = proposalOrigin === 'user_instruction'
      ? directProposals
      : proposalOrigin === 'strategy_program' || ['strategy_program_ready', 'verified_preparation_checkpoint'].includes(expansionTrigger)
        ? strategyProposals
      // capability_wait_release promotes a DORMANT first-life proposal (the
      // other proposals from the SAME batch as the currently-blocked task) —
      // it must reach firstLifeProposals the same way autoPlanProposal does,
      // regardless of policyConfigured. Missing this was the actual reason
      // the fix silently no-op'd live for org DIOR/Brdteengal: with an
      // unconfigured authority policy, this fell through to directProposals
      // only (user_instruction-origin todos), which doesn't include the
      // growth-plan-originated prospect-list/research proposals at all.
      : ['user_start', 'internal_bootstrap'].includes(expansionTrigger) || autoPlanProposal || expansionTrigger === 'capability_wait_release'
      ? firstLifeProposals
      : policyConfigured ? [...directProposals, ...firstLifeProposals] : directProposals;
    const ownershipStatuses = new Set([
      'READY', 'RUNNING', 'WAITING_FOR_CONNECTOR', 'WAITING_FOR_AUTHORITY', 'MONITORING',
    ]);
    const active = todos.map((todo) => ({
      ...todo,
      lifecycleStatus: projectedStatus(todo, runByTodo.get(todo.id) || null),
    })).filter((todo) => ownershipStatuses.has(todo.lifecycleStatus));
    // Root-caused live (2026-08-15, orgs DIOR/Brdteengal, then Singulance
    // itself): a promoted first-life task parks capacity-frozen — either
    // WAITING_FOR_CONNECTOR on a missing capability, or MONITORING while a
    // Room watches for provider replies — and nothing released its execution
    // slot, so other evidenced, genuinely independent proposals (a prospect
    // list, a TARA call sequence) sat PROPOSED indefinitely. The existing
    // verified_monitoring_checkpoint path ALSO covers MONITORING, but only
    // when the playbook stage itself declares waitingFor.releases_execution_
    // slot=true — the outreach playbook's observe_responses stage doesn't,
    // so that path silently never even attempts promotion (see the early
    // return a few lines up this file, gated on that exact flag), and the
    // system just sits idle until the run's own far-future scheduled
    // deadline. capability_wait_release is called unconditionally whenever
    // nothing is READY (native-engine.js), regardless of which capacity-
    // frozen state is occupying the slot or whether its playbook opted in —
    // it does not depend on any per-playbook authoring decision.
    if (['verified_monitoring_checkpoint', 'capability_wait_release'].includes(expansionTrigger)) {
      const releasableStatuses = expansionTrigger === 'capability_wait_release'
        ? ['WAITING_FOR_CONNECTOR', 'MONITORING'] : ['MONITORING'];
      for (const todo of active.filter((row) => effectClass(row) === 'external'
        && releasableStatuses.includes(row.lifecycleStatus)
        && asObject(row.context).execution_slot_released !== true)) {
        const changed = await tx.hqTodo.updateMany({
          where: { id: todo.id, runtimeId: runtime.id, status: { notIn: ['CANCELLED', 'COMPLETED'] } },
          data: { context: { ...asObject(todo.context), execution_slot_released: true, execution_slot_release_trigger: expansionTrigger } },
        });
        if (changed.count === 1) todo.context = { ...asObject(todo.context), execution_slot_released: true };
      }
    }
    const preparationMode = policy.auto_prepare_strategy_motions === true
      && (proposalOrigin === 'strategy_program' || ['strategy_program_ready', 'verified_preparation_checkpoint', 'verified_result'].includes(expansionTrigger));
    const countedExternal = active.filter((todo) => effectClass(todo) === 'external'
      && asObject(todo.context).execution_slot_released !== true);
    let externalAvailable = Math.max(0, Number(policy.external_execution_limit || 1)
      - countedExternal.length);
    let internalAvailable = Math.max(0, Number(policy.internal_execution_limit || 1)
      - active.filter((todo) => effectClass(todo) === 'internal').length);
    // Promotion is intentionally independent of how a proposal was authored.
    // Assignment happens later, through the Runtime-owned selector; filtering
    // here would strand historical proposals before that generic decision.
    const ordered = proposals.filter((todo) => todo.status === 'PROPOSED')
      .sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0)
        || Number(asObject(left.context).recommendation_rank || left.position || 0)
          - Number(asObject(right.context).recommendation_rank || right.position || 0));
    const recommended = ordered.find((todo) => asObject(todo.context).recommended === true) || ordered[0] || null;
    const selected = [];
    let preparationAvailable = Math.max(0, Number(policy.preparation_execution_limit || 1)
      - active.filter((todo) => ['READY', 'RUNNING'].includes(todo.lifecycleStatus)).length);
    const select = (todo) => {
      if (!todo || selected.some((row) => row.id === todo.id)) return;
      if (preparationMode) {
        if (preparationAvailable > 0) { selected.push(todo); preparationAvailable -= 1; }
        return;
      }
      const kind = effectClass(todo);
      if (kind === 'external' && externalAvailable > 0) {
        selected.push(todo); externalAvailable -= 1;
      } else if (kind === 'internal' && internalAvailable > 0) {
        selected.push(todo); internalAvailable -= 1;
      }
    };
    if (expansionTrigger === 'initial_plan_ready' && Number(policy.version) < 15) {
      // The first-life "wow batch" burst: every evidenced proposal from THIS
      // cohort starts together, in parallel — deliberately bypassing the
      // external/internal execution-limit capacity checks select() enforces
      // for ongoing operation. Those limits exist to keep steady-state
      // Runtime to one bounded task at a time (see roomInFlight in
      // native-engine.js); the very first activation is the one intentional
      // exception, so the founder sees the company move on multiple fronts
      // immediately instead of watching a single recommendation for days.
      // Every subsequent trigger (verified_result, capability_wait_release,
      // verified_monitoring_checkpoint, daily cadence's 'operate' mode, etc.)
      // is unaffected — it still goes through the strict one-at-a-time
      // selection below.
      for (const todo of ordered) if (!selected.some((row) => row.id === todo.id)) selected.push(todo);
    } else {
      select(recommended);
      const initialLimit = Number.isFinite(Number(policy.initial_execution_limit))
        ? Math.max(1, Number(policy.initial_execution_limit))
        : 2;
      if ((['user_start', 'internal_bootstrap'].includes(expansionTrigger) || policy.auto_start_initial_plan === true)
        && selected.length >= initialLimit) {
        // V3 starts only the recommendation. Historical policies without this
        // field preserve their prior companion-work behavior.
      } else if (recommended && effectClass(recommended) === 'external' && authorityPolicy.internal_autonomy !== false) {
        select(ordered.find((todo) => effectClass(todo) === 'internal'));
      } else if (expansionTrigger !== 'user_start') {
        select(ordered.find((todo) => effectClass(todo) === 'external'));
        select(ordered.find((todo) => effectClass(todo) === 'internal'));
      }
    }

    const promoted = [];
    for (const todo of selected) {
      const changed = await tx.hqTodo.updateMany({
        where: { id: todo.id, runtimeId: runtime.id, status: 'PROPOSED' },
        data: { status: 'READY', blockedReason: null, context: {
          ...asObject(todo.context), first_life_started: true, first_life_start_trigger: expansionTrigger,
        } },
      });
      if (changed.count === 1) promoted.push({ id: todo.id, title: todo.title, effect_class: effectClass(todo) });
    }
    return { promoted, reason: promoted.length ? 'capacity_available' : 'no_eligible_capacity' };
  });
}

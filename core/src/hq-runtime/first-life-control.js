import { loadFirstLifePolicy } from '../growth/first-life-policy.js';
import { projectRuntimePlaybookSnapshot } from '../runtime-playbooks/snapshot.js';
import { resolveAuthorityPreference } from './contracts.js';

function asObject(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function effectClass(todo) {
  const context = asObject(todo.context);
  return context.effect_class === 'external' || context.external_action_requested === true
    ? 'external' : 'internal';
}

function projectedStatus(todo, run) {
  const runStatus = String(run?.status || '').toUpperCase();
  if (runStatus === 'WAITING_AUTHORITY') return 'WAITING_FOR_AUTHORITY';
  if (runStatus === 'WAITING_EVENT') {
    return (run?.waitingFor?.types || []).includes('capability.connected')
      ? 'WAITING_FOR_CONNECTOR' : 'MONITORING';
  }
  if (runStatus === 'COMPLETED') return 'COMPLETED';
  if (['NEEDS_INTERVENTION', 'TERMINATED'].includes(runStatus) || todo.status === 'BLOCKED') return 'NEEDS_ATTENTION';
  if (run) return 'RUNNING';
  return String(todo.status || 'PROPOSED').toUpperCase();
}

export async function projectCurrentFirstLife({ prisma, orgId }) {
  const policy = await loadFirstLifePolicy();
  const [todos, runtime] = await Promise.all([
    prisma.hqTodo.findMany({
      where: { orgId, status: { notIn: ['CANCELLED'] } },
      orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
      take: 100,
    }),
    prisma.hqRuntime.findUnique({ where: { orgId }, select: { authorityPolicy: true } }),
  ]);
  const proposals = todos.filter((todo) => asObject(todo.context).first_life_policy_id === policy.policy_id);
  if (!proposals.length) return null;
  const firstLifeId = asObject(proposals[0].context).activation_sprint_id;
  const scoped = proposals.filter((todo) => asObject(todo.context).activation_sprint_id === firstLifeId);
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
  const preference = resolveAuthorityPreference(runtime?.authorityPolicy, null);
  const awaitingPolicy = policy.require_initial_policy_choice && preference === 'unconfigured';
  const proposed = items.filter((item) => item.status === 'PROPOSED');
  const needsAttention = items.some((item) => item.status === 'NEEDS_ATTENTION');
  const operating = items.some((item) => ['RUNNING', 'MONITORING', 'WAITING_FOR_AUTHORITY', 'WAITING_FOR_CONNECTOR'].includes(item.status));
  const responseLocale = items.find((item) => item.response_locale)?.response_locale || null;
  return {
    id: firstLifeId,
    policy: { id: policy.policy_id, version: policy.version },
    status: awaitingPolicy ? 'AWAITING_POLICY'
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
    waiting_reason: awaitingPolicy ? 'initial_policy_choice' : null,
    items,
  };
}

export async function activateEligibleFirstLifeWork({ prisma, runtime, expansionTrigger, recordExternalDefault = null }) {
  const policy = await loadFirstLifePolicy();
  if (!policy.expansion_triggers.includes(expansionTrigger)) return { promoted: [], reason: 'trigger_not_allowed' };
  return prisma.$transaction(async (tx) => {
    const locked = await tx.$queryRawUnsafe(
      `SELECT id, authority_policy
         FROM hivemind.hq_runtimes
        WHERE id=$1::uuid AND org_id=$2::uuid AND epoch=$3::uuid
        FOR UPDATE`,
      runtime.id, runtime.orgId, runtime.epoch,
    );
    if (!locked.length) throw new Error('first_life_runtime_epoch_conflict');
    let authorityPolicy = asObject(locked[0].authority_policy);
    if (recordExternalDefault != null) {
      if (!['manual', 'auto'].includes(recordExternalDefault)) throw new Error('first_life_external_default_invalid');
      authorityPolicy = {
        ...authorityPolicy,
        external_default: recordExternalDefault,
        gate_overrides: asObject(authorityPolicy.gate_overrides),
      };
      const updated = await tx.hqRuntime.updateMany({
        where: { id: runtime.id, orgId: runtime.orgId, epoch: runtime.epoch },
        data: { authorityPolicy, version: { increment: 1 } },
      });
      if (updated.count !== 1) throw new Error('first_life_runtime_epoch_conflict');
    }
    const policyConfigured = resolveAuthorityPreference(authorityPolicy, null) !== 'unconfigured';
    if (expansionTrigger === 'organization_policy' && !policyConfigured) {
      return { promoted: [], reason: 'initial_policy_required' };
    }

    const todos = await tx.hqTodo.findMany({
      where: { runtimeId: runtime.id, orgId: runtime.orgId, status: { notIn: ['CANCELLED'] } },
      orderBy: [{ priority: 'asc' }, { position: 'asc' }, { createdAt: 'asc' }],
    });
    const firstLifeProposals = todos.filter((todo) => asObject(todo.context).first_life_policy_id === policy.policy_id);
    const directProposals = todos.filter((todo) => asObject(todo.context).proposal_origin === 'user_instruction');
    const proposals = expansionTrigger === 'organization_policy'
      ? firstLifeProposals
      : policyConfigured ? [...directProposals, ...firstLifeProposals] : directProposals;
    const ownershipStatuses = new Set([
      'READY', 'RUNNING', 'WAITING_FOR_CONNECTOR', 'WAITING_FOR_AUTHORITY', 'MONITORING',
    ]);
    const active = todos.filter((todo) => ownershipStatuses.has(String(todo.status || '').toUpperCase()));
    if (expansionTrigger === 'verified_monitoring_checkpoint') {
      for (const todo of active.filter((row) => effectClass(row) === 'external'
        && String(row.status || '').toUpperCase() === 'MONITORING'
        && asObject(row.context).execution_slot_released !== true)) {
        const changed = await tx.hqTodo.updateMany({
          where: { id: todo.id, runtimeId: runtime.id, status: 'MONITORING' },
          data: { context: { ...asObject(todo.context), execution_slot_released: true, execution_slot_release_trigger: expansionTrigger } },
        });
        if (changed.count === 1) todo.context = { ...asObject(todo.context), execution_slot_released: true };
      }
    }
    const countedExternal = active.filter((todo) => effectClass(todo) === 'external'
      && asObject(todo.context).execution_slot_released !== true);
    let externalAvailable = Math.max(0, Number(policy.external_execution_limit || 1)
      - countedExternal.length);
    let internalAvailable = Math.max(0, Number(policy.internal_execution_limit || 1)
      - active.filter((todo) => effectClass(todo) === 'internal').length);
    const ordered = proposals.filter((todo) => todo.status === 'PROPOSED')
      .sort((left, right) => Number(left.priority || 0) - Number(right.priority || 0)
        || Number(asObject(left.context).recommendation_rank || left.position || 0)
          - Number(asObject(right.context).recommendation_rank || right.position || 0));
    const recommended = ordered.find((todo) => asObject(todo.context).recommended === true) || ordered[0] || null;
    const selected = [];
    const select = (todo) => {
      if (!todo || selected.some((row) => row.id === todo.id)) return;
      const kind = effectClass(todo);
      if (kind === 'external' && externalAvailable > 0) {
        selected.push(todo); externalAvailable -= 1;
      } else if (kind === 'internal' && internalAvailable > 0) {
        selected.push(todo); internalAvailable -= 1;
      }
    };
    select(recommended);
    if (recommended && effectClass(recommended) === 'external' && authorityPolicy.internal_autonomy !== false) {
      select(ordered.find((todo) => effectClass(todo) === 'internal'));
    } else if (expansionTrigger !== 'organization_policy') {
      select(ordered.find((todo) => effectClass(todo) === 'external'));
      select(ordered.find((todo) => effectClass(todo) === 'internal'));
    }

    const promoted = [];
    for (const todo of selected) {
      const changed = await tx.hqTodo.updateMany({
        where: { id: todo.id, runtimeId: runtime.id, status: 'PROPOSED' },
        data: { status: 'READY', blockedReason: null },
      });
      if (changed.count === 1) promoted.push({ id: todo.id, title: todo.title, effect_class: effectClass(todo) });
    }
    return { promoted, reason: promoted.length ? 'capacity_available' : 'no_eligible_capacity' };
  });
}

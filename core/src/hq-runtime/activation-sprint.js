import { projectRuntimePlaybookSnapshot } from '../runtime-playbooks/snapshot.js';
import { projectCurrentFirstLife } from './first-life-control.js';

function asObject(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : {}; }

function itemStatus(todo, run) {
  if (run?.status === 'WAITING_AUTHORITY') return 'READY_FOR_REVIEW';
  if (run?.status === 'WAITING_EVENT') return 'MONITORING';
  if (run?.status === 'COMPLETED') return 'COMPLETED';
  if (run?.status === 'NEEDS_INTERVENTION' || todo.status === 'BLOCKED') return 'NEEDS_ATTENTION';
  return run ? 'RUNNING' : todo.status;
}

export async function projectCurrentActivationSprint({ prisma, orgId }) {
  const firstLife = await projectCurrentFirstLife({ prisma, orgId });
  if (firstLife) return {
    ...firstLife,
    title: 'First Life',
    completed_count: firstLife.items.filter((item) => item.status === 'COMPLETED').length,
    item_count: firstLife.proposal_count,
    reviewable_run_ids: firstLife.items
      .filter((item) => item.execution?.status === 'WAITING_AUTHORITY')
      .map((item) => item.execution.execution_id),
    authority_policy_keys: [],
    pending_authority_policy_keys: [],
  };
  const [todos, runtime] = await Promise.all([
    prisma.hqTodo.findMany({
      where: { orgId, status: { notIn: ['CANCELLED'] } },
      orderBy: [{ createdAt: 'desc' }, { position: 'asc' }], take: 100,
    }),
    prisma.hqRuntime.findUnique({ where: { orgId }, select: { authorityPolicy: true } }),
  ]);
  const sprintTodo = todos.find((todo) => asObject(todo.context).activation_sprint_id);
  if (!sprintTodo) return null;
  const sprintId = asObject(sprintTodo.context).activation_sprint_id;
  const sprintTodos = todos.filter((todo) => asObject(todo.context).activation_sprint_id === sprintId)
    .sort((left, right) => left.position - right.position || left.priority - right.priority);
  const todoIds = sprintTodos.map((todo) => todo.id);
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
  const runIds = [...runByTodo.values()].map((run) => run.id);
  const campaigns = runIds.length ? await prisma.campaign.findMany({
    where: { orgId, sourceType: 'runtime_playbook', sourceId: { in: runIds } },
    select: { id: true, sourceId: true, name: true, status: true, requestedChannels: true, currentPlanVersionId: true, updatedAt: true },
  }) : [];
  const campaignByRun = new Map(campaigns.map((campaign) => [campaign.sourceId, campaign]));
  const items = sprintTodos.map((todo) => {
    const run = runByTodo.get(todo.id) || null;
    const campaign = run ? campaignByRun.get(run.id) || null : null;
    return {
      todo_id: todo.id,
      slot: asObject(todo.context).activation_slot || 'adaptive',
      title: todo.title,
      objective: todo.objective,
      room_tag: asObject(todo.context).room_tag || todo.kind,
      status: itemStatus(todo, run),
      execution: run ? projectRuntimePlaybookSnapshot(run) : null,
      campaign,
    };
  });
  const reviewable = items.filter((item) => item.execution?.status === 'WAITING_AUTHORITY');
  const requiredItems = items.filter((item) => item.slot !== 'adaptive');
  const authorityPolicyKeys = [...new Set(sprintTodos.flatMap((todo) => {
    const keys = asObject(todo.context).activation_authority_policy_keys;
    return Array.isArray(keys) ? keys.map(String).filter(Boolean) : [];
  }))];
  const pendingPolicyKeys = authorityPolicyKeys.filter((key) => !['manual', 'auto'].includes(asObject(runtime?.authorityPolicy)[key]));
  const requiredReady = requiredItems.length > 0 && requiredItems.every((item) => (
    ['READY_FOR_REVIEW', 'COMPLETED', 'MONITORING'].includes(item.status)
  ));
  return {
    id: sprintId,
    title: 'First Growth Sprint',
    status: pendingPolicyKeys.length ? 'AWAITING_POLICY'
      : reviewable.length && requiredReady ? 'READY_FOR_REVIEW'
        : items.every((item) => ['COMPLETED', 'MONITORING'].includes(item.status)) ? 'OPERATING' : 'PREPARING',
    completed_count: items.filter((item) => item.status === 'COMPLETED').length,
    item_count: items.length,
    reviewable_run_ids: reviewable.map((item) => item.execution.execution_id),
    authority_policy_keys: authorityPolicyKeys,
    pending_authority_policy_keys: pendingPolicyKeys,
    items,
  };
}

const TERMINAL_TODO_STATUSES = new Set(['COMPLETED', 'CANCELLED']);
const NONTERMINAL_RUN_STATUSES = new Set(['ACTIVE', 'WAITING_EVENT', 'WAITING_AUTHORITY', 'NEEDS_INTERVENTION']);
const ACTIVE_WORK_ORDER_STATUSES = new Set(['queued', 'running', 'processing']);

export function projectRuntimeLiveness({ todos = [], playbookRuns = [], workOrders = [] } = {}) {
  const retainedTodos = todos.filter((todo) => !TERMINAL_TODO_STATUSES.has(String(todo?.status || '').toUpperCase()));
  const retainedRuns = playbookRuns.filter((run) => NONTERMINAL_RUN_STATUSES.has(String(run?.status || '').toUpperCase()));
  const retainedWorkOrders = workOrders.filter((order) => ACTIVE_WORK_ORDER_STATUSES.has(String(order?.status || '').toLowerCase()));
  const capabilityRun = retainedRuns.find((run) => (run?.waitingFor?.types || []).includes('capability.connected')) || null;
  const capabilityTodo = retainedTodos.find((todo) => String(todo?.status || '') === 'WAITING_FOR_CONNECTOR') || null;
  const authorityRun = retainedRuns.find((run) => String(run?.status || '') === 'WAITING_AUTHORITY') || null;
  const eventRun = retainedRuns.find((run) => String(run?.status || '') === 'WAITING_EVENT' && run !== capabilityRun) || null;
  const activeRun = retainedRuns.find((run) => String(run?.status || '') === 'ACTIVE') || null;
  const runningTodo = retainedTodos.find((todo) => String(todo?.status || '') === 'RUNNING') || null;
  const readyTodo = retainedTodos.find((todo) => String(todo?.status || '') === 'READY') || null;
  const blockedTodo = retainedTodos.find((todo) => String(todo?.status || '') === 'BLOCKED') || null;
  const proposedTodo = retainedTodos.find((todo) => String(todo?.status || '') === 'PROPOSED') || null;

  let state = 'IDLE';
  if (readyTodo) state = 'EXECUTABLE';
  else if (runningTodo || activeRun || retainedWorkOrders.length) state = 'IN_FLIGHT';
  else if (capabilityTodo || capabilityRun) state = 'WAITING_CAPABILITY';
  else if (authorityRun) state = 'WAITING_AUTHORITY';
  else if (eventRun) state = 'WAITING_EVENT';
  else if (blockedTodo) state = 'BLOCKED';
  else if (proposedTodo) state = 'PROPOSED';

  return {
    state,
    queueEmpty: retainedTodos.length === 0 && retainedRuns.length === 0 && retainedWorkOrders.length === 0,
    hasRetainedWork: retainedTodos.length > 0 || retainedRuns.length > 0 || retainedWorkOrders.length > 0,
    readyTodo,
    runningTodo,
    capabilityTodo,
    capabilityRun,
    authorityRun,
    eventRun,
    activeRun,
    blockedTodo,
    proposedTodo,
    retainedTodos,
    retainedRuns,
    retainedWorkOrders,
  };
}

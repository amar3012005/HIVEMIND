import { Annotation, END, Send, START, StateGraph } from '@langchain/langgraph';

const appendUnique = (current, update) => [...new Set([
  ...(current || []),
  ...(Array.isArray(update) ? update : [update]).filter(Boolean),
])];

export const HQ_CHILD_EXECUTION_STATES = Object.freeze({
  RUNNABLE: new Set(['READY', 'EVENT_READY', 'RETRY_READY']),
  WAITING: new Set(['WAITING_EVENT', 'WAITING_DEADLINE', 'WAITING_APPROVAL', 'WAITING_CONNECTOR']),
  TERMINAL: new Set(['COMPLETED', 'CANCELLED', 'FAILED_TERMINAL']),
});

export const HqControlCycleState = Annotation.Root({
  cycleId: Annotation(),
  organizationId: Annotation(),
  trigger: Annotation(),
  executionIds: Annotation(),
  runnableIds: Annotation(),
  waitingIds: Annotation(),
  terminalIds: Annotation(),
  advancedIds: Annotation({ reducer: appendUnique, default: () => [] }),
  status: Annotation(),
  sleepAllowed: Annotation(),

  // Dynamic Send payload.
  executionId: Annotation(),
});

function classify(executions) {
  const groups = { runnableIds: [], waitingIds: [], terminalIds: [], unknownIds: [] };
  for (const execution of executions) {
    const status = String(execution.status || '').toUpperCase();
    if (HQ_CHILD_EXECUTION_STATES.RUNNABLE.has(status)) groups.runnableIds.push(execution.id);
    else if (HQ_CHILD_EXECUTION_STATES.WAITING.has(status)) groups.waitingIds.push(execution.id);
    else if (HQ_CHILD_EXECUTION_STATES.TERMINAL.has(status)) groups.terminalIds.push(execution.id);
    else groups.unknownIds.push(execution.id);
  }
  if (groups.unknownIds.length) {
    throw new Error(`hq_control_cycle_unknown_child_state:${groups.unknownIds.join(',')}`);
  }
  return groups;
}

export function createHqControlCycleGraph({ executionRepository, advanceExecution }) {
  if (!executionRepository || typeof executionRepository.listByOrganization !== 'function') {
    throw new Error('hq_control_cycle_repository_missing');
  }
  if (typeof advanceExecution !== 'function') {
    throw new Error('hq_control_cycle_advance_missing');
  }

  const load = async (state) => {
    if (!String(state.cycleId || '').trim()) throw new Error('hq_control_cycle_id_missing');
    if (!String(state.organizationId || '').trim()) throw new Error('hq_control_cycle_org_missing');
    const executions = await executionRepository.listByOrganization(state.organizationId);
    const groups = classify(executions);
    return {
      executionIds: executions.map((execution) => execution.id),
      ...groups,
      status: groups.runnableIds.length ? 'ADVANCING' : groups.waitingIds.length ? 'WAITING' : 'IDLE',
      sleepAllowed: groups.runnableIds.length === 0,
    };
  };

  const routeRunnable = (state) => {
    if (!state.runnableIds.length) return 'finalize';
    return state.runnableIds.map((executionId) => new Send('advanceChild', {
      cycleId: state.cycleId,
      organizationId: state.organizationId,
      trigger: state.trigger,
      executionId,
    }));
  };

  const advanceChild = async (state) => {
    await advanceExecution({
      organizationId: state.organizationId,
      executionId: state.executionId,
      trigger: state.trigger,
      cycleId: state.cycleId,
    });
    return { advancedIds: [state.executionId] };
  };

  const finalize = async (state) => {
    const executions = await executionRepository.listByOrganization(state.organizationId);
    const groups = classify(executions);
    const sleepAllowed = groups.runnableIds.length === 0;
    return {
      executionIds: executions.map((execution) => execution.id),
      ...groups,
      status: groups.runnableIds.length
        ? 'RUNNABLE_REMAINS'
        : groups.waitingIds.length ? 'WAITING' : 'IDLE',
      sleepAllowed,
    };
  };

  return new StateGraph(HqControlCycleState)
    .addNode('load', load)
    .addNode('advanceChild', advanceChild)
    .addNode('finalize', finalize)
    .addEdge(START, 'load')
    .addConditionalEdges('load', routeRunnable)
    .addEdge('advanceChild', 'finalize')
    .addEdge('finalize', END);
}

export function compileHqControlCycle(dependencies, { checkpointer } = {}) {
  return createHqControlCycleGraph(dependencies).compile({ checkpointer });
}

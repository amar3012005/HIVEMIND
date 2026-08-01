import { Annotation, END, START, StateGraph } from '@langchain/langgraph';

const appendUnique = (current, update) => [...new Set([
  ...(current || []),
  ...(Array.isArray(update) ? update : [update]).filter(Boolean),
])];

const appendHistory = (current, update) => [
  ...(current || []),
  ...(Array.isArray(update) ? update : [update]).filter(Boolean),
];

export const RoomOperatorState = Annotation.Root({
  executionId: Annotation(),
  organizationId: Annotation(),
  todoId: Annotation(),
  workOrderId: Annotation(),
  roomTag: Annotation(),
  objective: Annotation(),
  stage: Annotation(),
  completed: Annotation({ reducer: appendUnique, default: () => [] }),
  next: Annotation(),
  disposition: Annotation(),
  reason: Annotation(),
  requires: Annotation({ reducer: appendUnique, default: () => [] }),
  artifactRefs: Annotation({ reducer: appendUnique, default: () => [] }),
  evidenceRefs: Annotation({ reducer: appendUnique, default: () => [] }),
  checkpointHistory: Annotation({ reducer: appendHistory, default: () => [] }),
  status: Annotation(),
});

function lifecycleStatus(disposition) {
  return {
    complete: 'COMPLETED',
    continue_room: 'RUNNABLE',
    wait_event: 'WAITING_EVENT',
    wait_capability: 'WAITING_CONNECTOR',
    request_hq: 'WAITING_APPROVAL',
  }[String(disposition || '')] || 'FAILED_TERMINAL';
}

export function createRoomOperatorLifecycleGraph() {
  const retain = async (state) => {
    for (const field of ['executionId', 'organizationId', 'todoId', 'workOrderId', 'roomTag']) {
      if (!String(state[field] || '').trim()) throw new Error(`room_operator_${field}_missing`);
    }
    const status = lifecycleStatus(state.disposition);
    return {
      status,
      checkpointHistory: [{
        workOrderId: state.workOrderId,
        stage: state.stage || null,
        completed: state.completed || [],
        next: state.next || null,
        disposition: state.disposition,
        reason: state.reason || '',
        artifactRefs: state.artifactRefs || [],
        evidenceRefs: state.evidenceRefs || [],
        retainedAt: new Date().toISOString(),
      }],
    };
  };

  return new StateGraph(RoomOperatorState)
    .addNode('retainCheckpoint', retain)
    .addEdge(START, 'retainCheckpoint')
    .addEdge('retainCheckpoint', END);
}

export function compileRoomOperatorLifecycle({ checkpointer } = {}) {
  return createRoomOperatorLifecycleGraph().compile({ checkpointer });
}

export function roomOperatorThreadConfig({ organizationId, executionId }) {
  return {
    configurable: {
      thread_id: `room-operator:${organizationId}:${executionId}`,
      checkpoint_ns: 'room-operator',
    },
  };
}

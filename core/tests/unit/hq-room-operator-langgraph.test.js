import assert from 'node:assert/strict';
import test from 'node:test';
import { MemorySaver } from '@langchain/langgraph';

import {
  compileRoomOperatorLifecycle,
  roomOperatorThreadConfig,
} from '../../src/hq-runtime/langgraph/room-operator-lifecycle.js';

test('Room operator checkpoints preserve adaptive stage history across work orders', async () => {
  const graph = compileRoomOperatorLifecycle({ checkpointer: new MemorySaver() });
  const config = roomOperatorThreadConfig({ organizationId: 'org-1', executionId: 'workflow-1' });

  const first = await graph.invoke({
    executionId: 'workflow-1', organizationId: 'org-1', todoId: 'todo-1',
    workOrderId: 'work-1', roomTag: 'outreach', objective: 'Build qualified pipeline.',
    stage: 'discovery', completed: ['discovery'], next: 'qualification',
    disposition: 'continue_room', reason: 'Source-backed records exist.',
    artifactRefs: ['prospects-1'], evidenceRefs: ['places:one'], requires: [],
  }, config);
  assert.equal(first.status, 'RUNNABLE');
  assert.equal(first.checkpointHistory.length, 1);

  const second = await graph.invoke({
    executionId: 'workflow-1', organizationId: 'org-1', todoId: 'todo-1',
    workOrderId: 'work-2', roomTag: 'outreach', objective: 'Build qualified pipeline.',
    stage: 'qualification', completed: ['qualification'], next: 'persist leads',
    disposition: 'continue_room', reason: 'Qualified records are ready.',
    artifactRefs: ['qualified-1'], evidenceRefs: ['web:two'], requires: [],
  }, config);
  assert.equal(second.status, 'RUNNABLE');
  assert.deepEqual(second.completed, ['discovery', 'qualification']);
  assert.deepEqual(second.artifactRefs, ['prospects-1', 'qualified-1']);
  assert.equal(second.checkpointHistory.length, 2);
});

test('Room operator lifecycle distinguishes waiting, authority, and completion', async () => {
  for (const [disposition, expected] of [
    ['wait_event', 'WAITING_EVENT'],
    ['wait_capability', 'WAITING_CONNECTOR'],
    ['request_hq', 'WAITING_APPROVAL'],
    ['complete', 'COMPLETED'],
  ]) {
    const graph = compileRoomOperatorLifecycle({ checkpointer: new MemorySaver() });
    const result = await graph.invoke({
      executionId: `flow-${disposition}`, organizationId: 'org-1', todoId: 'todo-1',
      workOrderId: 'work-1', roomTag: 'outreach', objective: 'Operate outreach.',
      stage: 'delivery', completed: [], next: null, disposition, reason: '',
      artifactRefs: [], evidenceRefs: [], requires: [],
    }, roomOperatorThreadConfig({ organizationId: 'org-1', executionId: `flow-${disposition}` }));
    assert.equal(result.status, expected);
  }
});

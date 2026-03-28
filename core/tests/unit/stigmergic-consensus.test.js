import test from 'node:test';
import assert from 'node:assert/strict';
import { StigmergicCoT } from '../../src/memory/stigmergic-cot.js';
import { ByzantineConsensus } from '../../src/memory/byzantine-consensus.js';
import { InMemoryGraphStore } from '../../src/memory/graph-engine.js';

test('stigmergic CoT records, follows, and prunes traces', async () => {
  const store = new InMemoryGraphStore();
  const cot = new StigmergicCoT({ store, traceTTLMinutes: 30 });
  const userId = '00000000-0000-4000-8000-000000001101';
  const orgId = '00000000-0000-4000-8000-000000001102';

  const first = await cot.recordThought('agent-a', {
    userId,
    orgId,
    taskId: 'task-1',
    content: 'Check the recent deployment trail.',
    reasoning_type: 'step'
  });
  await cot.recordThought('agent-a', {
    userId,
    orgId,
    taskId: 'task-1',
    parentThoughtId: first.thoughtId,
    content: 'The rollback path is safer.',
    reasoning_type: 'conclusion'
  });
  const trace = await cot.depositTrace('agent-a', {
    userId,
    orgId,
    taskId: 'task-1',
    action: 'rollback',
    result: 'Recovered service in 2 minutes.',
    success: true
  });

  let followed = await cot.followTraces(userId, orgId, { taskId: 'task-1', limit: 10 });
  assert.equal(followed.affordances.length, 1);
  assert.equal(followed.fullChain.length, 2);
  assert.equal(trace.traceType, 'affordance');

  const traceMemory = await store.getMemory(trace.traceId);
  await store.updateMemory(trace.traceId, {
    metadata: {
      ...(traceMemory.metadata || {}),
      expires_at: '2000-01-01T00:00:00.000Z'
    }
  });

  const pruned = await cot.pruneStaleTraces(userId, orgId);
  followed = await cot.followTraces(userId, orgId, { taskId: 'task-1', limit: 10 });

  assert.equal(pruned.pruned, 1);
  assert.equal(followed.affordances.length, 0);
});

test('byzantine consensus returns commit verdict and cross-model verification', () => {
  const consensus = new ByzantineConsensus({ commitThreshold: 80 });
  const result = consensus.evaluateUpdate(
    { content: 'The production API now listens on port 3010.', memory_type: 'fact' },
    [{ content: 'The production API previously listened on port 3000.' }],
    [
      { agentId: 'model-a', scores: [92, 88, 90] },
      { agentId: 'model-b', scores: [90, 84, 91] }
    ]
  );

  const verification = consensus.crossModelVerify([
    { agentId: 'model-a', scores: [92, 88, 90] },
    { agentId: 'model-b', scores: [91, 85, 89] },
    { agentId: 'model-c', scores: [90, 86, 88] },
    { agentId: 'model-d', scores: [20, 15, 25] }
  ]);

  assert.equal(result.shouldCommit, true);
  assert.ok(result.consensusScores.average >= 80);
  assert.equal(verification.verified, true);
  assert.deepEqual(verification.divergentAgents, ['model-d']);
});

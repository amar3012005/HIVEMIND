import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';
import { ForceRouter } from '../../core/src/executor/force-router.js';
import { TrailSelector } from '../../core/src/executor/trail-selector.js';
import { ActionBinder } from '../../core/src/executor/action-binder.js';
import { ToolRegistry } from '../../core/src/executor/tool-registry.js';
import { ToolRunner } from '../../core/src/executor/tool-runner.js';
import { OutcomeWriter } from '../../core/src/executor/outcome-writer.js';
import { LeaseManager } from '../../core/src/executor/lease-manager.js';
import { TrailExecutor } from '../../core/src/executor/execution-loop.js';

function createTestExecutor() {
  const store = new InMemoryStore();
  const registry = new ToolRegistry();
  const runner = new ToolRunner(registry);
  const router = new ForceRouter({ forceWeights: { blueprintPrior: 0.3 } });
  const leaseManager = new LeaseManager(store);
  const selector = new TrailSelector(store, leaseManager, router);
  const binder = new ActionBinder(registry);
  const writer = new OutcomeWriter(store);

  registry.register({ name: 'graph_query', description: 'Query', params: { query: { type: 'string', required: true, description: 'q' } } });
  registry.register({ name: 'write_observation', description: 'Write', params: { kind: { type: 'string', required: true, description: 'k' }, content: { type: 'string', required: true, description: 'c' } } });

  runner.register('graph_query', async (params) => ({ results: [{ id: '1', content: 'found' }], count: 1 }));
  runner.register('write_observation', async (params) => ({ observation_id: 'obs_1', kind: params.kind, status: 'written', done: true }));

  const executor = new TrailExecutor({ trailSelector: selector, actionBinder: binder, toolRunner: runner, outcomeWriter: writer, leaseManager, store });
  return { executor, store, registry, runner };
}

describe('Blueprint execution', () => {
  it('should execute a blueprint action sequence end-to-end', async () => {
    const { executor, store } = createTestExecutor();
    await store.putTrail({
      id: 'bp_1', goalId: 'bp_test', agentId: 'a1', status: 'active', kind: 'blueprint',
      nextAction: { tool: 'graph_query', paramsTemplate: { query: 'test' } },
      blueprintMeta: {
        chainSignature: 'graph_query>write_observation',
        actionSequence: [
          { tool: 'graph_query', paramsTemplate: { query: 'test query' } },
          { tool: 'write_observation', paramsTemplate: { kind: 'finding', content: 'found something' } },
        ],
        state: 'active', version: 1, sourceChainHashes: [], sourceEventCount: 5,
        promotionStats: { avgSuccessRate: 1.0, avgLatencyMs: 40, avgSteps: 2, avgCostUsd: 0 },
        preconditions: [], expectedDoneReason: 'tool_signaled_completion', promotedAt: new Date().toISOString(),
      },
      steps: [], executionEventIds: [], successScore: 0.9, confidence: 0.9,
      weight: 0.8, decayRate: 0.02, tags: ['blueprint'], createdAt: new Date().toISOString(),
    });

    const result = await executor.execute('bp_test', 'agent_1', { maxSteps: 5, routing: { strategy: 'force_softmax', temperature: 0.1 } });

    expect(result.stepsExecuted).toBe(1);
    expect(result.eventsLogged).toBe(2);
    expect(result.finalState.done).toBe(true);
    expect(result.chainSummary.usedBlueprint).toBe(true);
    expect(result.chainSummary.blueprintChainSignature).toBe('graph_query>write_observation');
    expect(result.chainSummary.innerSteps).toBe(2);
    expect(result.chainSummary.doneReason).toBe('tool_signaled_completion');
  });

  it('should stop blueprint on first inner step failure', async () => {
    const { executor, store, runner } = createTestExecutor();
    runner.register('graph_query', async () => { throw new Error('query failed'); });

    await store.putTrail({
      id: 'bp_fail', goalId: 'fail_test', agentId: 'a1', status: 'active', kind: 'blueprint',
      nextAction: { tool: 'graph_query', paramsTemplate: { query: 'fail' } },
      blueprintMeta: {
        chainSignature: 'graph_query>write_observation',
        actionSequence: [
          { tool: 'graph_query', paramsTemplate: { query: 'fail' } },
          { tool: 'write_observation', paramsTemplate: { kind: 'x', content: 'y' } },
        ],
        state: 'active', version: 1, sourceChainHashes: [], sourceEventCount: 3,
        promotionStats: { avgSuccessRate: 1.0, avgLatencyMs: 40, avgSteps: 2, avgCostUsd: 0 },
        preconditions: [], expectedDoneReason: 'tool_signaled_completion', promotedAt: new Date().toISOString(),
      },
      steps: [], executionEventIds: [], successScore: 0.9, confidence: 0.9,
      weight: 0.8, decayRate: 0.02, tags: [], createdAt: new Date().toISOString(),
    });

    const result = await executor.execute('fail_test', 'agent_1', { maxSteps: 5, routing: { strategy: 'force_softmax', temperature: 0.1 } });
    expect(result.eventsLogged).toBe(1);
    expect(result.chainSummary.doneReason).toBe('blueprint_step_failed');
  });

  it('should release lease after blueprint execution', async () => {
    const { executor, store } = createTestExecutor();
    await store.putTrail({
      id: 'bp_lease', goalId: 'lease_test', agentId: 'a1', status: 'active', kind: 'blueprint',
      nextAction: { tool: 'write_observation', paramsTemplate: { kind: 'x', content: 'y' } },
      blueprintMeta: {
        chainSignature: 'write_observation',
        actionSequence: [{ tool: 'write_observation', paramsTemplate: { kind: 'test', content: 'done' } }],
        state: 'active', version: 1, sourceChainHashes: [], sourceEventCount: 3,
        promotionStats: { avgSuccessRate: 1.0, avgLatencyMs: 10, avgSteps: 1, avgCostUsd: 0 },
        preconditions: [], expectedDoneReason: 'tool_signaled_completion', promotedAt: new Date().toISOString(),
      },
      steps: [], executionEventIds: [], successScore: 0.9, confidence: 0.9,
      weight: 0.8, decayRate: 0.02, tags: [], createdAt: new Date().toISOString(),
    });

    await executor.execute('lease_test', 'agent_1', { maxSteps: 1, routing: { strategy: 'force_softmax', temperature: 0.1 } });
    const leased = await store.isLeased('bp_lease');
    expect(leased).toBe(false);
  });
});

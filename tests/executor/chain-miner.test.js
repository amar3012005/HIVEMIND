import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';

describe('Blueprint trail storage', () => {
  let store;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('should store and retrieve a blueprint trail with blueprintMeta', async () => {
    const blueprint = {
      id: 'bp_1', goalId: 'test_goal', agentId: 'agent_1', status: 'active',
      kind: 'blueprint',
      nextAction: { tool: 'graph_query', paramsTemplate: { query: 'test' } },
      blueprintMeta: {
        chainSignature: 'graph_query>write_observation',
        actionSequence: [
          { tool: 'graph_query', paramsTemplate: { query: '$ctx.q' } },
          { tool: 'write_observation', paramsTemplate: { kind: 'result', content: '$ctx.result' } },
        ],
        state: 'active', version: 1,
        sourceChainHashes: ['hash1'], sourceEventCount: 5,
        promotionStats: { avgSuccessRate: 1.0, avgLatencyMs: 40, avgSteps: 2, avgCostUsd: 0.001 },
        preconditions: [], expectedDoneReason: 'tool_signaled_completion',
        promotedAt: new Date().toISOString(),
      },
      steps: [], executionEventIds: [], successScore: 0.9, confidence: 0.9,
      weight: 0.8, decayRate: 0.05, tags: ['blueprint'], createdAt: new Date().toISOString(),
    };

    await store.putTrail(blueprint);
    const retrieved = await store.getTrail('bp_1');
    expect(retrieved.kind).toBe('blueprint');
    expect(retrieved.blueprintMeta.chainSignature).toBe('graph_query>write_observation');
    expect(retrieved.blueprintMeta.actionSequence).toHaveLength(2);
    expect(retrieved.blueprintMeta.state).toBe('active');
  });

  it('getCandidateTrails should return blueprint trails alongside raw trails', async () => {
    await store.putTrail({
      id: 'raw_1', goalId: 'g1', agentId: 'a1', status: 'active', kind: 'raw',
      nextAction: { tool: 'graph_query', paramsTemplate: {} },
      steps: [], executionEventIds: [], successScore: 0, confidence: 0.5,
      weight: 0.5, decayRate: 0.05, tags: [], createdAt: new Date().toISOString(),
    });
    await store.putTrail({
      id: 'bp_1', goalId: 'g1', agentId: 'a1', status: 'active', kind: 'blueprint',
      nextAction: { tool: 'graph_query', paramsTemplate: {} },
      blueprintMeta: { chainSignature: 'graph_query', actionSequence: [{ tool: 'graph_query', paramsTemplate: {} }], state: 'active', version: 1 },
      steps: [], executionEventIds: [], successScore: 0.9, confidence: 0.9,
      weight: 0.8, decayRate: 0.05, tags: [], createdAt: new Date().toISOString(),
    });

    const candidates = await store.getCandidateTrails('g1');
    expect(candidates).toHaveLength(2);
    expect(candidates.some(t => t.kind === 'blueprint')).toBe(true);
    expect(candidates.some(t => t.kind === 'raw')).toBe(true);
  });

  it('should default kind to "raw" when not specified', async () => {
    await store.putTrail({
      id: 'old_1', goalId: 'g1', agentId: 'a1', status: 'active',
      nextAction: { tool: 'echo', paramsTemplate: {} },
      steps: [], executionEventIds: [], successScore: 0, confidence: 0.5,
      weight: 0.5, decayRate: 0.05, tags: [], createdAt: new Date().toISOString(),
    });

    const trail = await store.getTrail('old_1');
    expect(trail.kind).toBe('raw');
  });
});

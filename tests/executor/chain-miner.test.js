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

import { ChainMiner } from '../../core/src/executor/chain-miner.js';

describe('ChainMiner', () => {
  let store;
  let miner;

  beforeEach(() => {
    store = new InMemoryStore();
    miner = new ChainMiner(store, {
      minOccurrences: 3,
      minSuccessRate: 0.9,
      maxAvgLatencyMs: 5000,
      lookbackRuns: 50,
      autoActivate: true,
    });
  });

  function seedChainRuns(goalId, toolSequences) {
    store.chainRuns = store.chainRuns || [];
    for (const seq of toolSequences) {
      store.chainRuns.push({
        goalId,
        trailId: 'trail_' + Math.random().toString(36).slice(2, 8),
        toolSequence: seq,
        successRate: 1.0,
        doneReason: 'tool_signaled_completion',
        totalLatencyMs: seq.length * 30,
      });
    }
  }

  it('should detect repeated chain pattern above threshold', async () => {
    seedChainRuns('goal_1', [
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['write_observation'],
    ]);

    const result = await miner.mine('goal_1');
    expect(result.candidatesCreated + result.blueprintsActivated).toBeGreaterThan(0);
    const detail = result.details.find(d => d.chainSignature === 'graph_query>write_observation');
    expect(detail).toBeDefined();
    expect(detail.occurrences).toBe(4);
  });

  it('should skip patterns below minOccurrences', async () => {
    seedChainRuns('goal_2', [
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['write_observation'],
    ]);

    const result = await miner.mine('goal_2');
    const gqWo = result.details.find(d => d.chainSignature === 'graph_query>write_observation');
    expect(gqWo.action).toBe('below_threshold');
  });

  it('should not create duplicate blueprints (idempotent)', async () => {
    seedChainRuns('goal_3', [
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
    ]);

    const result1 = await miner.mine('goal_3');
    expect(result1.candidatesCreated + result1.blueprintsActivated).toBeGreaterThan(0);

    const result2 = await miner.mine('goal_3');
    expect(result2.blueprintsSkippedExisting).toBeGreaterThan(0);
    expect(result2.candidatesCreated).toBe(0);
    expect(result2.blueprintsActivated).toBe(0);
  });

  it('should create blueprint trail with correct structure', async () => {
    seedChainRuns('goal_4', [
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
    ]);

    await miner.mine('goal_4');

    const allTrails = [...store.trails.values()];
    const blueprint = allTrails.find(t => t.kind === 'blueprint');
    expect(blueprint).toBeDefined();
    expect(blueprint.blueprintMeta.chainSignature).toBe('graph_query>write_observation');
    expect(blueprint.blueprintMeta.actionSequence).toHaveLength(2);
    expect(blueprint.blueprintMeta.actionSequence[0].tool).toBe('graph_query');
    expect(blueprint.blueprintMeta.actionSequence[1].tool).toBe('write_observation');
    expect(blueprint.blueprintMeta.state).toBe('active');
    expect(blueprint.blueprintMeta.version).toBe(1);
    expect(blueprint.blueprintMeta.sourceEventCount).toBe(3);
  });

  it('should canonicalize signatures correctly', () => {
    expect(ChainMiner.canonicalize(['graph_query', 'write_observation'])).toBe('graph_query>write_observation');
    expect(ChainMiner.canonicalize(['  graph_query ', ' write_observation'])).toBe('graph_query>write_observation');
    expect(ChainMiner.canonicalize(['a', '', 'b'])).toBe('a>b');
  });
});

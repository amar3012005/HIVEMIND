/**
 * Trail Selector — Unit Tests
 * HIVE-MIND Trail Executor
 *
 * @module tests/executor/trail-selector
 */

import { describe, it, expect, vi } from 'vitest';
import { TrailSelector } from '../../core/src/executor/trail-selector.js';
import { ForceRouter } from '../../core/src/executor/force-router.js';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTrail(overrides = {}) {
  return {
    id: 'trail-1',
    goalId: 'goal-1',
    namespaceId: 'ns-1',
    status: 'active',
    priority: 0,
    steps: [],
    nextAction: null,
    cumulativeTokens: 0,
    cumulativeSteps: 0,
    lastForceVector: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    tags: [],
    confidence: 1.0,
    successScore: 0,
    ...overrides,
  };
}

function makeGraphStore(trails = []) {
  return {
    getCandidateTrails: vi.fn().mockResolvedValue(trails),
  };
}

function makeLeaseManager(leaseMap = {}) {
  return {
    getLeaseInfo: vi.fn().mockImplementation(async (trailId) => {
      return leaseMap[trailId] ?? { leased: false };
    }),
  };
}

const DEFAULT_ROUTING_CONFIG = {
  strategy: 'force_softmax',
  temperature: 1.0,
  forceWeights: {
    goalAttraction: 1.0,
    affordanceAttraction: 1.0,
    conflictRepulsion: 1.0,
    congestionRepulsion: 1.0,
    costRepulsion: 1.0,
  },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('TrailSelector', () => {
  it('should return null when no candidates', async () => {
    const graphStore = makeGraphStore([]);
    const leaseManager = makeLeaseManager();
    const forceRouter = new ForceRouter();
    const selector = new TrailSelector(graphStore, leaseManager, forceRouter);

    const result = await selector.selectNext(
      'test goal',
      { goalId: 'goal-1', namespaceId: 'ns-1' },
      'agent-1',
      DEFAULT_ROUTING_CONFIG,
    );

    expect(result).toBeNull();
  });

  it('should return selected trail with routing decision', async () => {
    const trail = makeTrail({ id: 'trail-abc', tags: ['deploy'] });
    const graphStore = makeGraphStore([trail]);
    const leaseManager = makeLeaseManager();
    const forceRouter = new ForceRouter();
    const selector = new TrailSelector(graphStore, leaseManager, forceRouter);

    const result = await selector.selectNext(
      'deploy service',
      { goalId: 'goal-1', namespaceId: 'ns-1' },
      'agent-1',
      DEFAULT_ROUTING_CONFIG,
    );

    expect(result).not.toBeNull();
    expect(result.trailId).toBe('trail-abc');
    expect(result.trail).toBe(trail);
    expect(result.decision).toBeDefined();
    expect(result.decision.selectedTrailId).toBe('trail-abc');
    expect(result.decision.strategy).toBe('force_softmax');
  });

  it('should include force vector in routing decision', async () => {
    const trail = makeTrail({ id: 'trail-1', tags: ['search'], confidence: 0.7 });
    const graphStore = makeGraphStore([trail]);
    const leaseManager = makeLeaseManager();
    const forceRouter = new ForceRouter();
    const selector = new TrailSelector(graphStore, leaseManager, forceRouter);

    const result = await selector.selectNext(
      'search memories',
      { goalId: 'goal-1', namespaceId: 'ns-1' },
      'agent-1',
      DEFAULT_ROUTING_CONFIG,
    );

    const fv = result.decision.forceVector;
    expect(fv).toBeDefined();
    expect(typeof fv.goalAttraction).toBe('number');
    expect(typeof fv.affordanceAttraction).toBe('number');
    expect(typeof fv.conflictRepulsion).toBe('number');
    expect(typeof fv.congestionRepulsion).toBe('number');
    expect(typeof fv.costRepulsion).toBe('number');
    expect(typeof fv.net).toBe('number');
  });

  it('should include all candidate IDs in routing decision', async () => {
    const trails = [
      makeTrail({ id: 'trail-a' }),
      makeTrail({ id: 'trail-b' }),
      makeTrail({ id: 'trail-c' }),
    ];
    const graphStore = makeGraphStore(trails);
    const leaseManager = makeLeaseManager();
    const forceRouter = new ForceRouter();
    const selector = new TrailSelector(graphStore, leaseManager, forceRouter);

    const result = await selector.selectNext(
      'generic goal',
      { goalId: 'goal-1', namespaceId: 'ns-1' },
      'agent-1',
      DEFAULT_ROUTING_CONFIG,
    );

    expect(result.decision.candidateTrailIds).toEqual(
      expect.arrayContaining(['trail-a', 'trail-b', 'trail-c']),
    );
    expect(result.decision.candidateTrailIds).toHaveLength(3);
  });

  it('should skip trails with status !== active', async () => {
    const trails = [
      makeTrail({ id: 'active-1', status: 'active' }),
      makeTrail({ id: 'paused-1', status: 'paused' }),
      makeTrail({ id: 'completed-1', status: 'completed' }),
      makeTrail({ id: 'failed-1', status: 'failed' }),
    ];
    const graphStore = makeGraphStore(trails);
    const leaseManager = makeLeaseManager();
    const forceRouter = new ForceRouter();
    const selector = new TrailSelector(graphStore, leaseManager, forceRouter);

    const result = await selector.selectNext(
      'test goal',
      { goalId: 'goal-1', namespaceId: 'ns-1' },
      'agent-1',
      DEFAULT_ROUTING_CONFIG,
    );

    expect(result).not.toBeNull();
    expect(result.trailId).toBe('active-1');
    expect(result.decision.candidateTrailIds).toEqual(['active-1']);
  });
});

describe('TrailSelector blueprint filtering', () => {
  it('should exclude candidate blueprints from selection', async () => {
    const store = new InMemoryStore();
    await store.putTrail({
      id: 'raw_1', goalId: 'g1', agentId: 'a1', status: 'active', kind: 'raw',
      nextAction: { tool: 'echo', paramsTemplate: {} },
      steps: [], executionEventIds: [], successScore: 0.5, confidence: 0.5,
      weight: 0.5, decayRate: 0.05, tags: [], createdAt: new Date().toISOString(),
    });
    await store.putTrail({
      id: 'bp_cand', goalId: 'g1', agentId: 'a1', status: 'active', kind: 'blueprint',
      nextAction: { tool: 'echo', paramsTemplate: {} },
      blueprintMeta: { state: 'candidate', chainSignature: 'echo', actionSequence: [] },
      steps: [], executionEventIds: [], successScore: 0.9, confidence: 0.9,
      weight: 0.9, decayRate: 0.05, tags: [], createdAt: new Date().toISOString(),
    });

    const router = new ForceRouter();
    const leaseManager = { getLeaseInfo: async () => ({ leased: false }) };
    const selector = new TrailSelector(store, leaseManager, router);

    const selection = await selector.selectNext('g1', { goalId: 'g1', namespaceId: 'a1' }, 'a1', { temperature: 1.0 });
    expect(selection.trail.id).toBe('raw_1');
  });

  it('should exclude deprecated blueprints from selection', async () => {
    const store = new InMemoryStore();
    await store.putTrail({
      id: 'raw_1', goalId: 'g1', agentId: 'a1', status: 'active', kind: 'raw',
      nextAction: { tool: 'echo', paramsTemplate: {} },
      steps: [], executionEventIds: [], successScore: 0.5, confidence: 0.5,
      weight: 0.5, decayRate: 0.05, tags: [], createdAt: new Date().toISOString(),
    });
    await store.putTrail({
      id: 'bp_dep', goalId: 'g1', agentId: 'a1', status: 'active', kind: 'blueprint',
      nextAction: { tool: 'echo', paramsTemplate: {} },
      blueprintMeta: { state: 'deprecated', chainSignature: 'echo', actionSequence: [] },
      steps: [], executionEventIds: [], successScore: 0.9, confidence: 0.9,
      weight: 0.9, decayRate: 0.05, tags: [], createdAt: new Date().toISOString(),
    });

    const router = new ForceRouter();
    const leaseManager = { getLeaseInfo: async () => ({ leased: false }) };
    const selector = new TrailSelector(store, leaseManager, router);

    const selection = await selector.selectNext('g1', { goalId: 'g1', namespaceId: 'a1' }, 'a1', { temperature: 1.0 });
    expect(selection.trail.id).toBe('raw_1');
  });
});

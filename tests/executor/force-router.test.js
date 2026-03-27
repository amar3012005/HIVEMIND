/**
 * Force Router — Unit Tests
 * HIVE-MIND Trail Executor
 *
 * @module tests/executor/force-router
 */

import { describe, it, expect, vi } from 'vitest';
import {
  ForceRouter,
  goalSimilarity,
  historicalGoalSuccess,
  executableNowScore,
  paramBindabilityScore,
  contradictionRisk,
  recentFailureScore,
  activeLeasePressure,
  queueDepthPressure,
} from '../../core/src/executor/force-router.js';

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

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('ForceRouter', () => {
  describe('computeForces', () => {
    it('should compute positive goalAttraction for matching trail', () => {
      const router = new ForceRouter({ forceWeights: { goalAttraction: 1.0 } });
      const trail = makeTrail({
        tags: ['deploy', 'kubernetes'],
        successScore: 0.5,
      });

      const forces = router.computeForces(trail, { goal: 'deploy to kubernetes cluster' });

      expect(forces.goalAttraction).toBeGreaterThan(0);
      // 2/4 words match tags + 0.5 success = 0.5 + 0.5 = 1.0
      expect(forces.goalAttraction).toBeCloseTo(1.0, 1);
    });

    it('should compute zero affordanceAttraction for trail with no nextAction', () => {
      const router = new ForceRouter({ forceWeights: { affordanceAttraction: 1.0 } });
      const trail = makeTrail({ nextAction: null });

      const forces = router.computeForces(trail, {});

      expect(forces.affordanceAttraction).toBe(0);
    });

    it('should compute positive affordanceAttraction for trail with nextAction', () => {
      const router = new ForceRouter({ forceWeights: { affordanceAttraction: 1.0 } });
      const trail = makeTrail({
        status: 'active',
        nextAction: {
          toolName: 'memory.store',
          params: {},
          paramsTemplate: { content: '', tags: '' },
        },
      });

      const forces = router.computeForces(trail, {
        state: { content: 'hello' },
      });

      // executableNow = 1.0, paramBindability = 1/2 = 0.5
      expect(forces.affordanceAttraction).toBeCloseTo(1.5, 1);
    });

    it('should compute high conflictRepulsion for low-confidence trail', () => {
      const router = new ForceRouter({ forceWeights: { conflictRepulsion: 1.0 } });
      const trail = makeTrail({ confidence: 0.1 });

      const forces = router.computeForces(trail, {});

      // contradictionRisk = 1 - 0.1 = 0.9, failureScore = 0
      expect(forces.conflictRepulsion).toBeCloseTo(0.9, 1);
    });

    it('should compute high congestionRepulsion for leased trail', () => {
      const router = new ForceRouter({ forceWeights: { congestionRepulsion: 1.0 } });
      const trail = makeTrail();

      const forces = router.computeForces(trail, {
        leaseInfo: { leased: true },
        queueInfo: { depth: 5 },
      });

      // activeLease = 1.0, queueDepth = 5/10 = 0.5
      expect(forces.congestionRepulsion).toBeCloseTo(1.5, 1);
    });

    it('should return net force as sum of attractions minus repulsions', () => {
      const router = new ForceRouter({
        forceWeights: {
          goalAttraction: 1.0,
          affordanceAttraction: 1.0,
          conflictRepulsion: 1.0,
          congestionRepulsion: 1.0,
          costRepulsion: 1.0,
        },
      });

      const trail = makeTrail({
        tags: ['test'],
        confidence: 0.8,
        successScore: 0.3,
        status: 'active',
        nextAction: { toolName: 'test', params: {} },
      });

      const forces = router.computeForces(trail, { goal: 'test query' });

      const expectedNet =
        forces.goalAttraction +
        forces.affordanceAttraction -
        forces.conflictRepulsion -
        forces.congestionRepulsion -
        forces.costRepulsion;

      expect(forces.net).toBeCloseTo(expectedNet, 10);
    });
  });

  describe('softmaxSample', () => {
    it('should return a valid candidate', () => {
      const router = new ForceRouter();
      const candidates = [
        { trail: makeTrail({ id: 'a' }), forces: { net: 1.0 } },
        { trail: makeTrail({ id: 'b' }), forces: { net: 0.5 } },
        { trail: makeTrail({ id: 'c' }), forces: { net: 0.2 } },
      ];

      const result = router.softmaxSample(candidates, 1.0);
      expect(result).not.toBeNull();
      expect(['a', 'b', 'c']).toContain(result.trail.id);
    });

    it('should return null for empty candidates', () => {
      const router = new ForceRouter();
      expect(router.softmaxSample([], 1.0)).toBeNull();
    });

    it('with low temperature should favor highest net force', () => {
      const router = new ForceRouter();
      const candidates = [
        { trail: makeTrail({ id: 'high' }), forces: { net: 10.0 } },
        { trail: makeTrail({ id: 'low' }), forces: { net: -5.0 } },
      ];

      // With very low temperature, softmax becomes nearly argmax
      const counts = { high: 0, low: 0 };
      // Deterministic seeding not available, so run many samples
      // Mock Math.random to control sampling
      const randomValues = Array.from({ length: 100 }, (_, i) => i / 100);
      let callIndex = 0;
      vi.spyOn(Math, 'random').mockImplementation(() => {
        const val = randomValues[callIndex % randomValues.length];
        callIndex++;
        return val;
      });

      for (let i = 0; i < 100; i++) {
        const result = router.softmaxSample(candidates, 0.01);
        counts[result.trail.id]++;
      }

      vi.restoreAllMocks();

      // With temperature 0.01 and net diff of 15, high should dominate
      expect(counts.high).toBeGreaterThan(95);
    });

    it('with high temperature should be more uniform', () => {
      const router = new ForceRouter();
      const candidates = [
        { trail: makeTrail({ id: 'a' }), forces: { net: 2.0 } },
        { trail: makeTrail({ id: 'b' }), forces: { net: 1.0 } },
      ];

      // With very high temperature, distribution approaches uniform
      const counts = { a: 0, b: 0 };
      const randomValues = Array.from({ length: 200 }, (_, i) => i / 200);
      let callIndex = 0;
      vi.spyOn(Math, 'random').mockImplementation(() => {
        const val = randomValues[callIndex % randomValues.length];
        callIndex++;
        return val;
      });

      for (let i = 0; i < 200; i++) {
        const result = router.softmaxSample(candidates, 100.0);
        counts[result.trail.id]++;
      }

      vi.restoreAllMocks();

      // With temperature 100, both should be close to 50%
      expect(counts.a).toBeGreaterThan(80);
      expect(counts.b).toBeGreaterThan(80);
    });
  });

  describe('blueprint boost', () => {
    it('should add blueprintPrior to net force for active blueprints', () => {
      const router = new ForceRouter({ forceWeights: { blueprintPrior: 0.3 } });
      const blueprintTrail = {
        id: 'bp_1', kind: 'blueprint', status: 'active',
        blueprintMeta: { state: 'active', chainSignature: 'a>b' },
        tags: [], steps: [], successScore: 0.8, confidence: 0.9,
        nextAction: { tool: 'a', paramsTemplate: {} },
      };
      const rawTrail = {
        id: 'raw_1', kind: 'raw', status: 'active',
        tags: [], steps: [], successScore: 0.8, confidence: 0.9,
        nextAction: { tool: 'a', paramsTemplate: {} },
      };

      const bpForces = router.computeForces(blueprintTrail, { goal: 'test' });
      const rawForces = router.computeForces(rawTrail, { goal: 'test' });

      expect(bpForces.net).toBeGreaterThan(rawForces.net);
      expect(bpForces.blueprintBoost).toBe(0.3);
      expect(rawForces.blueprintBoost).toBe(0);
    });

    it('should not boost candidate or deprecated blueprints', () => {
      const router = new ForceRouter({ forceWeights: { blueprintPrior: 0.3 } });
      const candidate = {
        id: 'bp_2', kind: 'blueprint', status: 'active',
        blueprintMeta: { state: 'candidate' },
        tags: [], steps: [], successScore: 0.8, confidence: 0.9,
        nextAction: { tool: 'a', paramsTemplate: {} },
      };
      const deprecated = {
        id: 'bp_3', kind: 'blueprint', status: 'active',
        blueprintMeta: { state: 'deprecated' },
        tags: [], steps: [], successScore: 0.8, confidence: 0.9,
        nextAction: { tool: 'a', paramsTemplate: {} },
      };

      expect(router.computeForces(candidate, { goal: 'test' }).blueprintBoost).toBe(0);
      expect(router.computeForces(deprecated, { goal: 'test' }).blueprintBoost).toBe(0);
    });
  });
});

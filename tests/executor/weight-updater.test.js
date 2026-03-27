/**
 * Weight Updater — Unit Tests
 * HIVE-MIND Trail Executor
 *
 * @module tests/executor/weight-updater
 */

import { describe, it, expect } from 'vitest';
import { WeightUpdater } from '../../core/src/executor/weight-updater.js';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';

// ─── Fixtures ────────────────────────────────────────────────────────────────

function makeTrail(overrides = {}) {
  return {
    id: 'trail-1',
    goalId: 'goal-1',
    status: 'active',
    steps: [],
    confidence: 0.8,
    ...overrides,
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('WeightUpdater', () => {
  it('should compute weight with default inputs (confidence only)', async () => {
    const store = new InMemoryStore();
    const updater = new WeightUpdater(store);
    const trail = makeTrail();
    await store.putTrail(trail);

    const weight = await updater.update({ trail, confidence: 0.8 });

    // base=0.8, failure_penalty=0, reputation_boost=0.5*0.3=0.15,
    // novelty=0, downstream=0, cost_factor=1
    // 0.8 * 1 * 1.15 * 1 * 1 * 1 = 0.92
    expect(weight).toBeCloseTo(0.92, 2);
  });

  it('should reduce weight with high failure count', async () => {
    const store = new InMemoryStore();
    const updater = new WeightUpdater(store);
    const trail = makeTrail();

    const baseline = await updater.update({ trail, confidence: 0.8 });
    const withFailures = await updater.update({
      trail,
      confidence: 0.8,
      recentFailureCount: 10,
    });

    expect(withFailures).toBeLessThan(baseline);
    // failure_penalty = min((10/10)*0.5, 0.5) = 0.5
    // 0.8 * 0.5 * 1.15 * 1 * 1 * 1 = 0.46
    expect(withFailures).toBeCloseTo(0.46, 2);
  });

  it('should boost weight with high agent reputation', async () => {
    const store = new InMemoryStore();
    const updater = new WeightUpdater(store);
    const trail = makeTrail();

    const lowRep = await updater.update({
      trail,
      confidence: 0.8,
      agentReputation: 0.0,
    });
    const highRep = await updater.update({
      trail,
      confidence: 0.8,
      agentReputation: 1.0,
    });

    expect(highRep).toBeGreaterThan(lowRep);
    // highRep: 0.8 * 1 * 1.3 * 1 * 1 * 1 = 1.04 → clamped to 1.0
    expect(highRep).toBe(1.0);
    // lowRep: 0.8 * 1 * 1.0 * 1 * 1 * 1 = 0.8
    expect(lowRep).toBeCloseTo(0.8, 2);
  });

  it('should apply novelty discount', async () => {
    const store = new InMemoryStore();
    const updater = new WeightUpdater(store);
    const trail = makeTrail();

    const noNovelty = await updater.update({ trail, confidence: 0.8 });
    const withNovelty = await updater.update({
      trail,
      confidence: 0.8,
      noveltyPenalty: 0.1,
    });

    expect(withNovelty).toBeLessThan(noNovelty);
    // 0.8 * 1 * 1.15 * 0.9 * 1 * 1 = 0.828
    expect(withNovelty).toBeCloseTo(0.828, 2);
  });

  it('should boost weight with downstream success', async () => {
    const store = new InMemoryStore();
    const updater = new WeightUpdater(store);
    const trail = makeTrail();

    const baseline = await updater.update({ trail, confidence: 0.8 });
    const withDownstream = await updater.update({
      trail,
      confidence: 0.8,
      downstreamSuccessFactor: 1.0,
    });

    expect(withDownstream).toBeGreaterThan(baseline);
    // 0.8 * 1 * 1.15 * 1 * 1.2 * 1 = 1.104 → clamped to 1.0
    expect(withDownstream).toBe(1.0);
  });

  it('should apply cost penalty for expensive executions', async () => {
    const store = new InMemoryStore();
    const updater = new WeightUpdater(store);
    const trail = makeTrail();

    const cheap = await updater.update({ trail, confidence: 0.8, estimatedCostUsd: 0 });
    const expensive = await updater.update({
      trail,
      confidence: 0.8,
      estimatedCostUsd: 1.0,
    });

    expect(expensive).toBeLessThan(cheap);
    // cost_factor = 1 - min(1.0/1.0, 0.3) = 0.7
    // 0.8 * 1 * 1.15 * 1 * 1 * 0.7 = 0.644
    expect(expensive).toBeCloseTo(0.644, 2);
  });

  it('should clamp weight to [0, 1]', async () => {
    const store = new InMemoryStore();
    const updater = new WeightUpdater(store);
    const trail = makeTrail();

    // Very high signals that would push above 1.0
    const high = await updater.update({
      trail,
      confidence: 1.0,
      agentReputation: 1.0,
      downstreamSuccessFactor: 1.0,
    });
    expect(high).toBeLessThanOrEqual(1.0);
    expect(high).toBeGreaterThanOrEqual(0);

    // Confidence 0 should produce 0
    const zero = await updater.update({ trail, confidence: 0 });
    expect(zero).toBe(0);
  });

  it('should store weight components for explainability', async () => {
    const store = new InMemoryStore();
    const updater = new WeightUpdater(store);
    const trail = makeTrail();
    await store.putTrail(trail);

    await updater.update({
      trail,
      confidence: 0.7,
      recentFailureCount: 2,
      agentReputation: 0.8,
      noveltyPenalty: 0.1,
      downstreamSuccessFactor: 0.5,
      estimatedCostUsd: 0.3,
    });

    const stored = await store.getTrailWeight(trail.id);
    expect(stored).not.toBeNull();
    expect(stored.trail_id).toBe(trail.id);
    expect(stored.weight).toBeGreaterThan(0);
    expect(stored.components).toEqual({
      base_confidence: 0.7,
      failure_penalty: 0.1,
      agent_reputation_boost: 0.24,
      novelty_discount: 0.1,
      downstream_success_factor: 0.1,
      cost_factor: 0.7,
    });
    expect(stored.updated_at).toBeTruthy();

    // Trail object should also have updated weight
    const updatedTrail = await store.getTrail(trail.id);
    expect(updatedTrail.weight).toBe(stored.weight);
  });
});

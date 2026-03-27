/**
 * Outcome Writer — Unit Tests
 * HIVE-MIND Trail Executor
 *
 * @module tests/executor/outcome-writer
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { OutcomeWriter, truncate } from '../../core/src/executor/outcome-writer.js';
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
    ...overrides,
  };
}

function makeAction(overrides = {}) {
  return {
    toolName: 'memory.store',
    params: { key: 'val' },
    rationale: 'test rationale',
    ...overrides,
  };
}

function makeToolResult(overrides = {}) {
  return {
    result: { stored: true },
    error: null,
    latencyMs: 42,
    tokensUsed: 100,
    estimatedCostUsd: 0.001,
    ...overrides,
  };
}

function makeWorkingMemory(overrides = {}) {
  return {
    agentId: 'agent-1',
    stepIndex: 0,
    ...overrides,
  };
}

const routingDecision = {
  selectedTrailId: 'trail-1',
  forceVector: { goal: 0.8, history: 0.1, executable: 0.5 },
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('OutcomeWriter', () => {
  let store;
  let writer;
  let trail;

  beforeEach(() => {
    store = new InMemoryStore();
    writer = new OutcomeWriter(store);
    trail = makeTrail();
    store.putTrail(trail);
  });

  it('should create execution event with correct fields', async () => {
    const event = await writer.write(
      trail,
      makeAction(),
      makeToolResult(),
      routingDecision,
      makeWorkingMemory(),
    );

    expect(event).toMatchObject({
      trail_id: 'trail-1',
      agent_id: 'agent-1',
      step_index: 0,
      action_name: 'memory.store',
      bound_params: { key: 'val' },
      success: true,
      latency_ms: 42,
      tokens_used: 100,
      estimated_cost_usd: 0.001,
    });
    expect(event.id).toBeTruthy();
    expect(event.timestamp).toBeTruthy();
  });

  it('should append step summary to trail', async () => {
    await writer.write(
      trail,
      makeAction(),
      makeToolResult(),
      routingDecision,
      makeWorkingMemory(),
    );

    const stored = await store.getTrail('trail-1');
    expect(stored.steps).toHaveLength(1);
    expect(stored.steps[0]).toMatchObject({
      index: 0,
      status: 'succeeded',
      action: { toolName: 'memory.store', params: { key: 'val' } },
    });
    expect(stored.steps[0].resultSummary).toBeTruthy();
  });

  it('should truncate long results in step summary', async () => {
    const longResult = 'x'.repeat(500);
    await writer.write(
      trail,
      makeAction(),
      makeToolResult({ result: longResult }),
      null,
      makeWorkingMemory(),
    );

    const stored = await store.getTrail('trail-1');
    expect(stored.steps[0].resultSummary.length).toBeLessThanOrEqual(200);
    expect(stored.steps[0].resultSummary.endsWith('\u2026')).toBe(true);
  });

  it('should include routing decision in event', async () => {
    const event = await writer.write(
      trail,
      makeAction(),
      makeToolResult(),
      routingDecision,
      makeWorkingMemory(),
    );

    expect(event.routing).toEqual(routingDecision);
  });

  it('should mark event as success when no error', async () => {
    const event = await writer.write(
      trail,
      makeAction(),
      makeToolResult({ error: null }),
      null,
      makeWorkingMemory(),
    );

    expect(event.success).toBe(true);
    expect(event.error).toBeNull();
  });

  it('should mark event as failed when error present', async () => {
    const event = await writer.write(
      trail,
      makeAction(),
      makeToolResult({ error: 'timeout', result: null }),
      null,
      makeWorkingMemory(),
    );

    expect(event.success).toBe(false);
    expect(event.error).toBe('timeout');
    expect(event.result).toBeNull();

    const stored = await store.getTrail('trail-1');
    expect(stored.steps[0].status).toBe('failed');
  });

  it('should generate unique event IDs', async () => {
    const e1 = await writer.write(trail, makeAction(), makeToolResult(), null, makeWorkingMemory());
    const e2 = await writer.write(trail, makeAction(), makeToolResult(), null, makeWorkingMemory({ stepIndex: 1 }));

    expect(e1.id).not.toBe(e2.id);
  });
});

describe('truncate', () => {
  it('should return short strings unchanged', () => {
    expect(truncate('hello', 200)).toBe('hello');
  });

  it('should truncate long strings with ellipsis', () => {
    const long = 'a'.repeat(300);
    const result = truncate(long, 200);
    expect(result.length).toBe(200);
    expect(result.endsWith('\u2026')).toBe(true);
  });

  it('should stringify objects', () => {
    expect(truncate({ a: 1 })).toBe('{"a":1}');
  });
});

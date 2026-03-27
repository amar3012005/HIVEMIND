/**
 * Execution Loop — Integration Tests
 * HIVE-MIND Trail Executor
 *
 * @module tests/executor/execution-loop
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { TrailExecutor } from '../../core/src/executor/execution-loop.js';
import { TrailSelector } from '../../core/src/executor/trail-selector.js';
import { ForceRouter } from '../../core/src/executor/force-router.js';
import { ActionBinder } from '../../core/src/executor/action-binder.js';
import { ToolRunner } from '../../core/src/executor/tool-runner.js';
import { ToolRegistry } from '../../core/src/executor/tool-registry.js';
import { OutcomeWriter } from '../../core/src/executor/outcome-writer.js';
import { LeaseManager } from '../../core/src/executor/lease-manager.js';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';

// ─── Setup Helper ─────────────────────────────────────────────────────────────

function createTestExecutor() {
  const store = new InMemoryStore();
  const forceRouter = new ForceRouter();
  const leaseManager = new LeaseManager(store);
  const toolRegistry = new ToolRegistry();
  const trailSelector = new TrailSelector(store, leaseManager, forceRouter);
  const actionBinder = new ActionBinder(toolRegistry);
  const toolRunner = new ToolRunner(toolRegistry);
  const outcomeWriter = new OutcomeWriter(store);

  // Register a test tool
  toolRegistry.register({
    name: 'echo',
    description: 'Returns input as output',
    params: { message: { type: 'string', required: true, description: 'Message to echo' } },
  });
  toolRunner.register('echo', async (params) => ({ echoed: params.message }));

  // Create a test trail in store
  store.trails.set('trail_1', {
    id: 'trail_1',
    goalId: 'test_goal',
    agentId: 'agent_1',
    status: 'active',
    nextAction: { tool: 'echo', paramsTemplate: { message: 'hello' } },
    steps: [],
    executionEventIds: [],
    successScore: 0.8,
    confidence: 0.9,
    weight: 0.7,
    decayRate: 0.05,
    tags: ['test'],
    createdAt: new Date().toISOString(),
  });

  const executor = new TrailExecutor({
    trailSelector,
    actionBinder,
    toolRunner,
    outcomeWriter,
    leaseManager,
    store,
  });

  return { executor, store, toolRegistry, toolRunner };
}

const DEFAULT_CONFIG = {
  maxSteps: 1,
  budget: { maxWallClockMs: 30000 },
  routing: {
    strategy: 'force_softmax',
    temperature: 1.0,
    forceWeights: {
      goalAttraction: 1.0,
      affordanceAttraction: 1.0,
      conflictRepulsion: 1.0,
      congestionRepulsion: 1.0,
      costRepulsion: 1.0,
    },
  },
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('TrailExecutor — ExecutionLoop', () => {
  let executor, store, toolRegistry, toolRunner;

  beforeEach(() => {
    ({ executor, store, toolRegistry, toolRunner } = createTestExecutor());
  });

  it('should execute a single trail step successfully', async () => {
    const result = await executor.execute('test_goal', 'agent_1', DEFAULT_CONFIG);

    expect(result.stepsExecuted).toBe(1);
    expect(result.eventsLogged).toBe(1);
  });

  it('should return ExecutionResult with correct fields', async () => {
    const result = await executor.execute('test_goal', 'agent_1', DEFAULT_CONFIG);

    expect(result).toMatchObject({
      goal: 'test_goal',
      agentId: 'agent_1',
      stepsExecuted: expect.any(Number),
      eventsLogged: expect.any(Number),
      nextRecommendedGoal: undefined,
    });
    expect(result.finalState).toBeDefined();
    expect(result.finalState.context).toBeDefined();
    expect(result.finalState.observations).toBeInstanceOf(Array);
    expect(result.finalState.recentTrailHistory).toBeInstanceOf(Array);
    expect(result.trailsUpdated).toBeInstanceOf(Array);
    expect(result.observationsForEval).toBeInstanceOf(Array);
  });

  it('should log execution event in store', async () => {
    await executor.execute('test_goal', 'agent_1', DEFAULT_CONFIG);

    const events = await store.getEvents('trail_1');
    expect(events.length).toBeGreaterThanOrEqual(1);
    expect(events[0].trail_id).toBe('trail_1');
    expect(events[0].agent_id).toBe('agent_1');
    expect(events[0].success).toBe(true);
  });

  it('should append step to trail', async () => {
    await executor.execute('test_goal', 'agent_1', DEFAULT_CONFIG);

    const trail = await store.getTrail('trail_1');
    expect(trail.steps.length).toBeGreaterThanOrEqual(1);
    expect(trail.steps[0].status).toBe('succeeded');
    expect(trail.steps[0].action.toolName).toBe('echo');
  });

  it('should release lease after execution', async () => {
    await executor.execute('test_goal', 'agent_1', DEFAULT_CONFIG);

    const isLeased = await store.isLeased('trail_1');
    expect(isLeased).toBe(false);
  });

  it('should handle execution errors without crashing loop', async () => {
    // Register a tool that always fails
    toolRegistry.register({
      name: 'fail_tool',
      description: 'Always fails',
      params: { input: { type: 'string', required: true, description: 'Input' } },
    });
    toolRunner.register('fail_tool', async () => {
      throw new Error('Intentional failure');
    });

    // Set the trail to use the failing tool
    store.trails.set('trail_fail', {
      id: 'trail_fail',
      goalId: 'test_goal',
      agentId: 'agent_1',
      status: 'active',
      nextAction: { tool: 'fail_tool', paramsTemplate: { input: 'test' } },
      steps: [],
      executionEventIds: [],
      successScore: 0.5,
      confidence: 0.5,
      weight: 0.5,
      decayRate: 0.05,
      tags: ['test'],
      createdAt: new Date().toISOString(),
    });

    // Remove the good trail so only failing trail is available
    store.trails.delete('trail_1');

    const result = await executor.execute('test_goal', 'agent_1', {
      ...DEFAULT_CONFIG,
      maxSteps: 3,
    });

    // Should not throw — loop should handle errors gracefully
    expect(result.stepsExecuted).toBeGreaterThanOrEqual(1);
    expect(result.finalState.failuresCount).toBeGreaterThanOrEqual(1);
  });

  it('should stop when maxSteps reached', async () => {
    const result = await executor.execute('test_goal', 'agent_1', {
      ...DEFAULT_CONFIG,
      maxSteps: 3,
    });

    // With one trail that keeps being selected, should run up to maxSteps
    expect(result.stepsExecuted).toBeLessThanOrEqual(3);
  });

  it('should stop when no more trails available', async () => {
    // Remove all trails
    store.trails.clear();

    const result = await executor.execute('test_goal', 'agent_1', {
      ...DEFAULT_CONFIG,
      maxSteps: 10,
    });

    expect(result.stepsExecuted).toBe(0);
    expect(result.eventsLogged).toBe(0);
  });

  it('should skip leased trails and continue', async () => {
    // Pre-lease the trail with a different agent
    await store.acquireLease('trail_1', 'other_agent', 60000);

    const result = await executor.execute('test_goal', 'agent_1', {
      ...DEFAULT_CONFIG,
      maxSteps: 3,
    });

    // The trail is leased by another agent, so steps are skipped (no events logged)
    // The loop should still complete without crashing
    expect(result.eventsLogged).toBe(0);
    expect(result.stepsExecuted).toBeLessThanOrEqual(3);
  });
});

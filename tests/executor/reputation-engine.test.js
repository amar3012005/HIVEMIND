import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';
import { ReputationEngine } from '../../core/src/executor/reputation-engine.js';

describe('ReputationEngine', () => {
  let store;
  let engine;

  beforeEach(() => {
    store = new InMemoryStore();
    engine = new ReputationEngine(store);
  });

  it('should initialize default reputation for new agent', async () => {
    const rep = await engine.getReputation('new_agent');
    expect(rep.success_rate).toBe(0.5);
    expect(rep.avg_confidence).toBe(0.5);
    expect(rep.recent_attempts).toBe(0);
    expect(rep.skill_scores).toEqual({});
    expect(rep.blueprint_scores).toEqual({});
    expect(rep.specialization_confidence.explorer).toBe(0);
  });

  it('should update success_rate with EMA on successful execution', async () => {
    await engine.updateFromExecution('agent_1', {
      chainSummary: { doneReason: 'tool_signaled_completion', successRate: 1.0, toolSequence: ['graph_query', 'write_observation'], totalLatencyMs: 50, usedBlueprint: false },
      stepsExecuted: 2,
    });
    const rep = await engine.getReputation('agent_1');
    expect(rep.success_rate).toBeGreaterThan(0.5);
    expect(rep.recent_attempts).toBe(1);
  });

  it('should update per-tool skill scores', async () => {
    await engine.updateFromExecution('agent_1', {
      chainSummary: { doneReason: 'tool_signaled_completion', successRate: 1.0, toolSequence: ['graph_query'], totalLatencyMs: 30, usedBlueprint: false },
      stepsExecuted: 1,
    });
    const rep = await engine.getReputation('agent_1');
    expect(rep.skill_scores.graph_query).toBeDefined();
    expect(rep.skill_scores.graph_query.executions).toBe(1);
    expect(rep.skill_scores.graph_query.success_rate).toBeGreaterThan(0.5);
  });

  it('should update blueprint_scores when blueprint was used', async () => {
    await engine.updateFromExecution('agent_1', {
      chainSummary: { doneReason: 'tool_signaled_completion', successRate: 1.0, toolSequence: ['graph_query', 'write_observation'], totalLatencyMs: 40, usedBlueprint: true, blueprintChainSignature: 'graph_query>write_observation' },
      stepsExecuted: 1,
    });
    const rep = await engine.getReputation('agent_1');
    expect(rep.blueprint_scores['graph_query>write_observation']).toBeDefined();
    expect(rep.blueprint_scores['graph_query>write_observation'].executions).toBe(1);
  });

  it('should decrease success_rate on failed execution', async () => {
    await engine.updateFromExecution('agent_1', {
      chainSummary: { doneReason: 'tool_signaled_completion', successRate: 1.0, toolSequence: ['echo'], totalLatencyMs: 10, usedBlueprint: false },
      stepsExecuted: 1,
    });
    await engine.updateFromExecution('agent_1', {
      chainSummary: { doneReason: 'blueprint_step_failed', successRate: 0.0, toolSequence: ['echo'], totalLatencyMs: 10, usedBlueprint: false },
      stepsExecuted: 1,
    });
    const rep = await engine.getReputation('agent_1');
    expect(rep.success_rate).toBeLessThan(0.55);
  });

  it('should cap specialization at 0.6 until MIN_EVIDENCE met', async () => {
    for (let i = 0; i < 5; i++) {
      await engine.updateFromExecution('agent_1', {
        chainSummary: { doneReason: 'tool_signaled_completion', successRate: 1.0, toolSequence: ['graph_query', 'write_observation'], totalLatencyMs: 30, usedBlueprint: false },
        stepsExecuted: 2,
      });
    }
    const rep = await engine.getReputation('agent_1');
    expect(rep.specialization_confidence.explorer).toBeLessThanOrEqual(0.6);
    expect(rep.specialization_confidence.operator).toBeLessThanOrEqual(0.6);
  });

  it('should update agent last_seen_at', async () => {
    await store.ensureAgent('agent_1');
    await engine.updateFromExecution('agent_1', {
      chainSummary: { doneReason: 'tool_signaled_completion', successRate: 1.0, toolSequence: ['echo'], totalLatencyMs: 5, usedBlueprint: false },
      stepsExecuted: 1,
    });
    const agent = await store.getAgent('agent_1');
    expect(agent.last_seen_at).toBeDefined();
  });
});

// tests/executor/dashboard.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';
import { Dashboard } from '../../core/src/executor/dashboard.js';

function seedExecutionData(store) {
  // Seed chain runs as observations
  for (let i = 0; i < 20; i++) {
    const success = i < 17; // 85% success
    const usedBlueprint = i % 3 === 0; // 33% blueprint usage
    store.events.push({
      id: `evt_${i}`,
      trail_id: usedBlueprint ? 'bp_trail_1' : `raw_trail_${i % 3}`,
      agent_id: i < 10 ? 'explorer_1' : 'auto_agent',
      step_index: 0,
      action_name: i % 2 === 0 ? 'graph_query' : 'write_observation',
      bound_params: {},
      result: success ? { done: true } : null,
      error: success ? null : 'failed',
      latency_ms: 20 + i * 2,
      success,
      tokens_used: 100,
      estimated_cost_usd: 0.001,
      routing: {
        selectedTrailId: usedBlueprint ? 'bp_trail_1' : `raw_trail_${i % 3}`,
        candidateTrailIds: ['bp_trail_1', 'raw_trail_0', 'raw_trail_1'],
        forceVector: {
          goalAttraction: 0.8, affordanceAttraction: 0.5, blueprintBoost: usedBlueprint ? 0.3 : 0,
          socialAttraction: 0.05, momentum: 0.03,
          conflictRepulsion: 0.2, congestionRepulsion: 0.1, costRepulsion: 0.05,
          net: 0.5,
        },
        temperature: 1.0,
        strategy: 'force_softmax',
      },
      timestamp: new Date(Date.now() - (20 - i) * 3600000).toISOString(),
      created_at: new Date(Date.now() - (20 - i) * 3600000).toISOString(),
    });
  }

  // Seed chain runs
  if (!store.chainRuns) store.chainRuns = [];
  for (let i = 0; i < 20; i++) {
    store.chainRuns.push({
      goalId: 'test_goal',
      toolSequence: i % 2 === 0 ? ['graph_query', 'write_observation'] : ['write_observation'],
      successRate: i < 17 ? 1.0 : 0.0,
      doneReason: i < 17 ? 'tool_signaled_completion' : 'budget_exhausted',
      totalLatencyMs: 30 + i,
    });
  }

  // Seed agents
  store._agents = new Map();
  store._agents.set('explorer_1', {
    agent_id: 'explorer_1', role: 'explorer', source: 'explicit',
    status: 'active', skills: ['graph_query'], last_seen_at: new Date().toISOString(),
  });
  store._agents.set('auto_agent', {
    agent_id: 'auto_agent', role: 'generalist', source: 'implicit',
    status: 'active', skills: [], last_seen_at: new Date().toISOString(),
  });

  // Seed reputations
  store._reputations = new Map();
  store._reputations.set('explorer_1', {
    agent_id: 'explorer_1', success_rate: 0.9, avg_confidence: 0.85,
    skill_scores: { graph_query: { success_rate: 0.95, avg_latency_ms: 30, executions: 15 } },
    blueprint_scores: { 'graph_query>write_observation': { success_rate: 1.0, executions: 5 } },
    specialization_confidence: { explorer: 0.7, operator: 0.5, evaluator: 0 },
    recent_attempts: 15,
  });

  // Seed blueprint trail
  store.trails.set('bp_trail_1', {
    id: 'bp_trail_1', goalId: 'test_goal', status: 'active', kind: 'blueprint',
    blueprintMeta: { chainSignature: 'graph_query>write_observation', state: 'active' },
    weight: 0.9, confidence: 0.9, successScore: 0.9, steps: [], tags: [],
  });
}

describe('Dashboard', () => {
  let store;
  let dashboard;

  beforeEach(() => {
    store = new InMemoryStore();
    seedExecutionData(store);
    dashboard = new Dashboard(store);
  });

  it('overview should return execution metrics', async () => {
    const result = await dashboard.overview({ window: 'all' });
    expect(result.executions.total).toBe(20);
    expect(result.executions.successRate).toBeCloseTo(0.85, 1);
    expect(result.executions.doneReasons).toBeDefined();
  });

  it('overview should return blueprint metrics', async () => {
    const result = await dashboard.overview({ window: 'all' });
    expect(result.blueprints).toBeDefined();
    expect(result.blueprints.active).toBeGreaterThanOrEqual(0);
  });

  it('overview should return agent metrics', async () => {
    const result = await dashboard.overview({ window: 'all' });
    expect(result.agents.total).toBe(2);
    expect(result.agents.active).toBe(2);
  });

  it('overview should return routing force contributions', async () => {
    const result = await dashboard.overview({ window: 'all' });
    expect(result.routing.forceContributions.goalAttraction).toBeGreaterThan(0);
  });

  it('executions should return recent events with filters', async () => {
    const result = await dashboard.executions({ limit: 5, window: 'all' });
    expect(result.executions.length).toBeLessThanOrEqual(5);
    expect(result.executions[0]).toHaveProperty('action_name');
  });

  it('executions should filter by agent_id', async () => {
    const result = await dashboard.executions({ agentId: 'explorer_1', window: 'all' });
    expect(result.executions.every(e => e.agent_id === 'explorer_1')).toBe(true);
  });

  it('blueprints should return blueprint performance', async () => {
    const result = await dashboard.blueprints({ window: 'all' });
    expect(result.blueprints).toBeDefined();
  });

  it('agents should return agent performance with reputation', async () => {
    const result = await dashboard.agents({ window: 'all' });
    expect(result.agents.length).toBe(2);
    expect(result.agents[0]).toHaveProperty('agent_id');
    expect(result.agents[0]).toHaveProperty('status');
  });
});

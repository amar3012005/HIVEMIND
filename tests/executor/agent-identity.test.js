// tests/executor/agent-identity.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';

describe('Agent lifecycle', () => {
  let store;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('ensureAgent should create implicit agent if not exists', async () => {
    const agent = await store.ensureAgent('explorer_1');
    expect(agent.agent_id).toBe('explorer_1');
    expect(agent.source).toBe('implicit');
    expect(agent.role).toBe('generalist');
    expect(agent.status).toBe('active');
  });

  it('ensureAgent should return existing agent without modifying', async () => {
    await store.ensureAgent('explorer_1', { role: 'explorer' });
    const agent = await store.ensureAgent('explorer_1', { role: 'operator' });
    expect(agent.role).toBe('explorer'); // not overwritten
  });

  it('getAgent should return null for unknown agent', async () => {
    const agent = await store.getAgent('nonexistent');
    expect(agent).toBeNull();
  });

  it('listAgents should filter by role', async () => {
    await store.ensureAgent('a1', { role: 'explorer' });
    await store.ensureAgent('a2', { role: 'operator' });
    await store.ensureAgent('a3', { role: 'explorer' });
    const explorers = await store.listAgents({ role: 'explorer' });
    expect(explorers).toHaveLength(2);
  });

  it('listAgents should filter by source', async () => {
    await store.ensureAgent('impl_1');
    await store.ensureAgent('expl_1', { source: 'explicit', role: 'operator' });
    const implicits = await store.listAgents({ source: 'implicit' });
    expect(implicits).toHaveLength(1);
    expect(implicits[0].agent_id).toBe('impl_1');
  });

  it('updateAgent should modify mutable fields only', async () => {
    await store.ensureAgent('a1', { role: 'generalist', source: 'implicit' });
    await store.updateAgent('a1', { role: 'operator', skills: ['graph_query'] });
    const agent = await store.getAgent('a1');
    expect(agent.role).toBe('operator');
    expect(agent.skills).toEqual(['graph_query']);
    expect(agent.source).toBe('implicit'); // immutable
  });

  it('updateAgentLastSeen should update timestamp', async () => {
    await store.ensureAgent('a1');
    await store.updateAgentLastSeen('a1');
    const agent = await store.getAgent('a1');
    expect(agent.last_seen_at).toBeDefined();
  });
});

describe('Reputation storage', () => {
  let store;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('getReputation should return null for unknown agent', async () => {
    const rep = await store.getReputation('nonexistent');
    expect(rep).toBeNull();
  });

  it('updateReputation should upsert reputation', async () => {
    const rep = {
      success_rate: 0.85,
      avg_confidence: 0.8,
      skill_scores: { graph_query: { success_rate: 0.9, avg_latency_ms: 30, executions: 10 } },
      blueprint_scores: {},
      specialization_confidence: { explorer: 0.5, operator: 0.3, evaluator: 0 },
      recent_attempts: 10,
    };
    await store.updateReputation('agent_1', rep);
    const loaded = await store.getReputation('agent_1');
    expect(loaded.success_rate).toBe(0.85);
    expect(loaded.skill_scores.graph_query.executions).toBe(10);
  });

  it('updateReputation should overwrite existing', async () => {
    await store.updateReputation('agent_1', { success_rate: 0.5, recent_attempts: 1 });
    await store.updateReputation('agent_1', { success_rate: 0.9, recent_attempts: 2 });
    const loaded = await store.getReputation('agent_1');
    expect(loaded.success_rate).toBe(0.9);
    expect(loaded.recent_attempts).toBe(2);
  });
});

# Agent Identity + Reputation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add persistent agent profiles with earned reputation, enabling ForceRouter V2 force terms (socialAttraction, momentum) that make routing identity-aware.

**Architecture:** Agents are auto-created on first execution (implicit) or registered explicitly. A ReputationEngine updates agent reputation synchronously after each execution using EMA. ForceRouter gains two new force terms fed by reputation data. Everything builds on existing executor infrastructure.

**Tech Stack:** Node.js ES modules, Vitest, Prisma (PostgreSQL), vanilla Node HTTP server.

---

## File Structure

### New Files
```
core/src/executor/reputation-engine.js     — EMA-based reputation updates + specialization confidence
tests/executor/reputation-engine.test.js   — Reputation tests
tests/executor/agent-identity.test.js      — Agent lifecycle + integration tests
core/prisma/migrations/20260327200000_add_agent_identity_fields/migration.sql
```

### Modified Files
```
core/prisma/schema.prisma                  — Add source, last_seen_at to OpAgent
core/src/executor/stores/in-memory-store.js — Agent CRUD + reputation methods
core/src/executor/stores/prisma-store.js    — Agent CRUD + reputation methods
core/src/executor/force-router.js           — Add socialAttraction + momentum
core/src/executor/trail-selector.js         — Pass reputationContext
core/src/executor/execution-loop.js         — Wire ensureAgent, loadRep, updateRep
core/src/server.js                          — Agent API endpoints, ReputationEngine init
```

---

## Task 1: Schema Migration

**Files:**
- Create: `core/prisma/migrations/20260327200000_add_agent_identity_fields/migration.sql`
- Modify: `core/prisma/schema.prisma`

- [ ] **Step 1: Create migration SQL**

```sql
-- core/prisma/migrations/20260327200000_add_agent_identity_fields/migration.sql
ALTER TABLE op_agents ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'implicit';
ALTER TABLE op_agents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
```

- [ ] **Step 2: Add fields to Prisma schema**

In `core/prisma/schema.prisma`, find the `OpAgent` model and add after `status`:

```prisma
  source        String   @default("implicit") // implicit, explicit
  last_seen_at  DateTime?
```

- [ ] **Step 3: Format and validate**

```bash
cd core && npx prisma format
```

- [ ] **Step 4: Commit**

```bash
git add core/prisma/migrations/20260327200000_add_agent_identity_fields/migration.sql core/prisma/schema.prisma
git commit -m "feat: add source and last_seen_at to OpAgent schema"
```

---

## Task 2: Store Agent + Reputation Methods

**Files:**
- Modify: `core/src/executor/stores/in-memory-store.js`
- Modify: `core/src/executor/stores/prisma-store.js`
- Create: `tests/executor/agent-identity.test.js`

- [ ] **Step 1: Write failing tests for agent lifecycle**

```js
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/executor/agent-identity.test.js
```
Expected: FAIL — `store.ensureAgent` not defined.

- [ ] **Step 3: Add agent + reputation methods to InMemoryStore**

Add to `core/src/executor/stores/in-memory-store.js`:

```js
  // ─── Agent Methods ──────────────────────────────────────────────────────────

  /** Idempotent: create agent if not exists, return existing if found. */
  async ensureAgent(agentId, defaults = {}) {
    if (!this._agents) this._agents = new Map();
    const existing = this._agents.get(agentId);
    if (existing) return existing;

    const agent = {
      id: randomUUID(),
      agent_id: agentId,
      role: defaults.role || 'generalist',
      model_version: defaults.model || '',
      skills: defaults.skills || [],
      status: 'active',
      source: defaults.source || 'implicit',
      last_seen_at: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    this._agents.set(agentId, agent);
    return agent;
  }

  /** Get agent by agent_id. */
  async getAgent(agentId) {
    if (!this._agents) return null;
    return this._agents.get(agentId) ?? null;
  }

  /** List agents with optional filters. */
  async listAgents(filters = {}) {
    if (!this._agents) return [];
    let agents = [...this._agents.values()];
    if (filters.role) agents = agents.filter(a => a.role === filters.role);
    if (filters.status) agents = agents.filter(a => a.status === filters.status);
    if (filters.source) agents = agents.filter(a => a.source === filters.source);
    return agents;
  }

  /** Update mutable agent fields (role, skills, status, model_version). */
  async updateAgent(agentId, updates) {
    if (!this._agents) return null;
    const agent = this._agents.get(agentId);
    if (!agent) return null;
    if (updates.role) agent.role = updates.role;
    if (updates.skills) agent.skills = updates.skills;
    if (updates.status) agent.status = updates.status;
    if (updates.model_version) agent.model_version = updates.model_version;
    agent.updated_at = new Date().toISOString();
    return agent;
  }

  /** Touch last_seen_at. */
  async updateAgentLastSeen(agentId) {
    if (!this._agents) return;
    const agent = this._agents.get(agentId);
    if (agent) agent.last_seen_at = new Date().toISOString();
  }

  // ─── Reputation Methods ─────────────────────────────────────────────────────

  /** Get reputation for an agent. */
  async getReputation(agentId) {
    if (!this._reputations) return null;
    return this._reputations.get(agentId) ?? null;
  }

  /** Upsert full reputation object. */
  async updateReputation(agentId, rep) {
    if (!this._reputations) this._reputations = new Map();
    this._reputations.set(agentId, { agent_id: agentId, ...rep, updated_at: new Date().toISOString() });
  }
```

- [ ] **Step 4: Add agent + reputation methods to PrismaStore**

Add to `core/src/executor/stores/prisma-store.js`:

```js
  // ─── Agent Methods ──────────────────────────────────────────────────────────

  async ensureAgent(agentId, defaults = {}) {
    const existing = await this.prisma.opAgent.findFirst({ where: { agent_id: agentId } });
    if (existing) return this._mapAgentRow(existing);

    const created = await this.prisma.opAgent.create({
      data: {
        agent_id: agentId,
        role: defaults.role || 'generalist',
        model_version: defaults.model || '',
        skills: defaults.skills || [],
        status: 'active',
        source: defaults.source || 'implicit',
      },
    });
    return this._mapAgentRow(created);
  }

  async getAgent(agentId) {
    const row = await this.prisma.opAgent.findFirst({ where: { agent_id: agentId } });
    return row ? this._mapAgentRow(row) : null;
  }

  async listAgents(filters = {}) {
    const where = {};
    if (filters.role) where.role = filters.role;
    if (filters.status) where.status = filters.status;
    if (filters.source) where.source = filters.source;
    const rows = await this.prisma.opAgent.findMany({ where, orderBy: { created_at: 'desc' } });
    return rows.map(r => this._mapAgentRow(r));
  }

  async updateAgent(agentId, updates) {
    const data = {};
    if (updates.role) data.role = updates.role;
    if (updates.skills) data.skills = updates.skills;
    if (updates.status) data.status = updates.status;
    if (updates.model_version) data.model_version = updates.model_version;
    try {
      const row = await this.prisma.opAgent.update({
        where: { agent_id: agentId },
        data,
      });
      return this._mapAgentRow(row);
    } catch { return null; }
  }

  async updateAgentLastSeen(agentId) {
    try {
      await this.prisma.opAgent.update({
        where: { agent_id: agentId },
        data: { last_seen_at: new Date() },
      });
    } catch { /* agent may not exist */ }
  }

  _mapAgentRow(row) {
    return {
      id: row.id,
      agent_id: row.agent_id,
      role: row.role,
      model_version: row.model_version,
      skills: Array.isArray(row.skills) ? row.skills : JSON.parse(row.skills || '[]'),
      status: row.status,
      source: row.source || 'implicit',
      last_seen_at: row.last_seen_at?.toISOString?.() || row.last_seen_at,
      created_at: row.created_at?.toISOString?.() || row.created_at,
      updated_at: row.updated_at?.toISOString?.() || row.updated_at,
    };
  }

  // ─── Reputation Methods ─────────────────────────────────────────────────────

  async getReputation(agentId) {
    const row = await this.prisma.metaReputation.findUnique({ where: { agent_id: agentId } });
    if (!row) return null;
    const scores = row.skill_scores || {};
    return {
      agent_id: row.agent_id,
      success_rate: row.success_rate,
      avg_confidence: row.avg_confidence,
      skill_scores: scores.skill_scores || scores,
      blueprint_scores: scores.blueprint_scores || {},
      specialization_confidence: scores.specialization_confidence || { explorer: 0, operator: 0, evaluator: 0 },
      recent_attempts: row.recent_attempts,
      updated_at: row.updated_at?.toISOString?.() || row.updated_at,
    };
  }

  async updateReputation(agentId, rep) {
    const skillScoresPayload = {
      skill_scores: rep.skill_scores || {},
      blueprint_scores: rep.blueprint_scores || {},
      specialization_confidence: rep.specialization_confidence || {},
    };
    await this.prisma.metaReputation.upsert({
      where: { agent_id: agentId },
      create: {
        agent_id: agentId,
        success_rate: rep.success_rate ?? 0.5,
        avg_confidence: rep.avg_confidence ?? 0.5,
        skill_scores: skillScoresPayload,
        recent_attempts: rep.recent_attempts ?? 0,
      },
      update: {
        success_rate: rep.success_rate ?? 0.5,
        avg_confidence: rep.avg_confidence ?? 0.5,
        skill_scores: skillScoresPayload,
        recent_attempts: rep.recent_attempts ?? 0,
      },
    });
  }
```

- [ ] **Step 5: Run tests**

```bash
npx vitest run tests/executor/agent-identity.test.js
```
Expected: PASS (9 tests)

- [ ] **Step 6: Run all executor tests**

```bash
npx vitest run tests/executor/
```
Expected: All 94+ tests pass.

- [ ] **Step 7: Commit**

```bash
git add core/src/executor/stores/in-memory-store.js core/src/executor/stores/prisma-store.js tests/executor/agent-identity.test.js
git commit -m "feat: add agent CRUD + reputation methods to stores"
```

---

## Task 3: ReputationEngine

**Files:**
- Create: `core/src/executor/reputation-engine.js`
- Create: `tests/executor/reputation-engine.test.js`

- [ ] **Step 1: Write failing tests**

```js
// tests/executor/reputation-engine.test.js
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
    const result = {
      chainSummary: {
        doneReason: 'tool_signaled_completion',
        successRate: 1.0,
        toolSequence: ['graph_query', 'write_observation'],
        totalLatencyMs: 50,
        usedBlueprint: false,
      },
      stepsExecuted: 2,
    };

    await engine.updateFromExecution('agent_1', result);
    const rep = await engine.getReputation('agent_1');
    expect(rep.success_rate).toBeGreaterThan(0.5); // EMA moved toward 1.0
    expect(rep.recent_attempts).toBe(1);
  });

  it('should update per-tool skill scores', async () => {
    const result = {
      chainSummary: {
        doneReason: 'tool_signaled_completion',
        successRate: 1.0,
        toolSequence: ['graph_query'],
        totalLatencyMs: 30,
        usedBlueprint: false,
      },
      stepsExecuted: 1,
    };

    await engine.updateFromExecution('agent_1', result);
    const rep = await engine.getReputation('agent_1');
    expect(rep.skill_scores.graph_query).toBeDefined();
    expect(rep.skill_scores.graph_query.executions).toBe(1);
    expect(rep.skill_scores.graph_query.success_rate).toBeGreaterThan(0.5);
  });

  it('should update blueprint_scores when blueprint was used', async () => {
    const result = {
      chainSummary: {
        doneReason: 'tool_signaled_completion',
        successRate: 1.0,
        toolSequence: ['graph_query', 'write_observation'],
        totalLatencyMs: 40,
        usedBlueprint: true,
        blueprintChainSignature: 'graph_query>write_observation',
      },
      stepsExecuted: 1,
    };

    await engine.updateFromExecution('agent_1', result);
    const rep = await engine.getReputation('agent_1');
    expect(rep.blueprint_scores['graph_query>write_observation']).toBeDefined();
    expect(rep.blueprint_scores['graph_query>write_observation'].executions).toBe(1);
  });

  it('should decrease success_rate on failed execution', async () => {
    // First: a success
    await engine.updateFromExecution('agent_1', {
      chainSummary: { doneReason: 'tool_signaled_completion', successRate: 1.0, toolSequence: ['echo'], totalLatencyMs: 10, usedBlueprint: false },
      stepsExecuted: 1,
    });

    // Then: a failure
    await engine.updateFromExecution('agent_1', {
      chainSummary: { doneReason: 'blueprint_step_failed', successRate: 0.0, toolSequence: ['echo'], totalLatencyMs: 10, usedBlueprint: false },
      stepsExecuted: 1,
    });

    const rep = await engine.getReputation('agent_1');
    expect(rep.success_rate).toBeLessThan(0.55); // EMA pulled down
  });

  it('should cap specialization confidence at 0.6 until MIN_EVIDENCE met', async () => {
    // Run 5 executions (below MIN_EVIDENCE of 10)
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
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/executor/reputation-engine.test.js
```
Expected: FAIL — `ReputationEngine` not found.

- [ ] **Step 3: Implement ReputationEngine**

```js
// core/src/executor/reputation-engine.js

/**
 * Trail Executor — Reputation Engine
 * HIVE-MIND Cognitive Runtime
 *
 * Updates agent reputation from execution outcomes using exponential
 * moving averages. Computes specialization confidence from behavior.
 *
 * @module executor/reputation-engine
 */

const DEFAULT_REPUTATION = {
  success_rate: 0.5,
  avg_confidence: 0.5,
  skill_scores: {},
  blueprint_scores: {},
  specialization_confidence: { explorer: 0, operator: 0, evaluator: 0 },
  recent_attempts: 0,
};

const EMA_ALPHA = 0.1;
const MIN_EVIDENCE = 10;
const MAX_CONFIDENCE_WITHOUT_EVIDENCE = 0.6;

export class ReputationEngine {
  constructor(store) {
    this.store = store;
  }

  /**
   * Get current reputation or return defaults.
   * @param {string} agentId
   * @returns {Promise<object>}
   */
  async getReputation(agentId) {
    const stored = await this.store.getReputation(agentId);
    if (stored) return { ...DEFAULT_REPUTATION, ...stored };
    return { ...DEFAULT_REPUTATION, agent_id: agentId };
  }

  /**
   * Update reputation from an execution result.
   * @param {string} agentId
   * @param {{ chainSummary: object, stepsExecuted: number }} result
   */
  async updateFromExecution(agentId, result) {
    const rep = await this.getReputation(agentId);
    const cs = result.chainSummary;
    if (!cs) return;

    const α = EMA_ALPHA;

    // 1. Agent-level success (execution completion)
    const execSuccess = cs.doneReason === 'tool_signaled_completion' ? 1.0 : 0.0;
    rep.success_rate = rep.success_rate * (1 - α) + execSuccess * α;
    rep.avg_confidence = rep.avg_confidence * (1 - α) + (execSuccess > 0.5 ? 0.9 : 0.3) * α;

    // 2. Per-tool skill scores
    const toolSeq = cs.toolSequence || [];
    const perToolLatency = cs.totalLatencyMs && toolSeq.length
      ? cs.totalLatencyMs / toolSeq.length : 50;

    for (const tool of toolSeq) {
      const existing = rep.skill_scores[tool] || { success_rate: 0.5, avg_latency_ms: 100, executions: 0 };
      existing.success_rate = existing.success_rate * (1 - α) + execSuccess * α;
      existing.avg_latency_ms = existing.avg_latency_ms * (1 - α) + perToolLatency * α;
      existing.executions++;
      rep.skill_scores[tool] = existing;
    }

    // 3. Blueprint scores
    if (cs.usedBlueprint && cs.blueprintChainSignature) {
      const sig = cs.blueprintChainSignature;
      const existing = rep.blueprint_scores[sig] || { success_rate: 0.5, executions: 0 };
      existing.success_rate = existing.success_rate * (1 - α) + execSuccess * α;
      existing.executions++;
      rep.blueprint_scores[sig] = existing;
    }

    // 4. Specialization confidence (derived, evidence-gated)
    rep.recent_attempts++;
    rep.specialization_confidence = this._computeSpecialization(rep);

    // 5. Persist
    await this.store.updateReputation(agentId, rep);

    // 6. Update agent last_seen_at
    if (this.store.updateAgentLastSeen) {
      await this.store.updateAgentLastSeen(agentId);
    }
  }

  /**
   * Compute specialization confidence from behavioral evidence.
   * @param {object} rep
   * @returns {{ explorer: number, operator: number, evaluator: number }}
   */
  _computeSpecialization(rep) {
    const cap = rep.recent_attempts >= MIN_EVIDENCE ? 1.0 : MAX_CONFIDENCE_WITHOUT_EVIDENCE;

    const uniqueTools = Object.keys(rep.skill_scores).length;
    const bpScores = Object.values(rep.blueprint_scores);
    const totalBpExecs = bpScores.reduce((s, b) => s + (b.executions || 0), 0);
    const avgBpSuccess = bpScores.length
      ? bpScores.reduce((s, b) => s + b.success_rate, 0) / bpScores.length
      : 0;

    const explorer = Math.min(
      (uniqueTools > 2 ? 0.3 : 0.1) +
      (rep.recent_attempts > 20 ? 0.2 : 0.0) +
      (totalBpExecs < 3 ? 0.2 : 0.0) + // low blueprint reliance = explorer
      (rep.success_rate * 0.3),
      cap,
    );

    const operatorCap = totalBpExecs >= MIN_EVIDENCE ? 1.0 : MAX_CONFIDENCE_WITHOUT_EVIDENCE;
    const operator = Math.min(
      (avgBpSuccess * 0.4) +
      (rep.success_rate * 0.4) +
      (rep.recent_attempts > 10 ? 0.2 : 0.0),
      Math.min(cap, operatorCap),
    );

    const evaluator = 0.0; // placeholder until evaluator agents exist

    return { explorer, operator, evaluator };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
npx vitest run tests/executor/reputation-engine.test.js
```
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/executor/reputation-engine.js tests/executor/reputation-engine.test.js
git commit -m "feat: implement ReputationEngine with EMA updates + specialization confidence"
```

---

## Task 4: ForceRouter V2 — Social + Momentum

**Files:**
- Modify: `core/src/executor/force-router.js`
- Modify: `tests/executor/force-router.test.js`

- [ ] **Step 1: Write failing tests for V2 force terms**

Append to `tests/executor/force-router.test.js`:

```js
describe('ForceRouter V2: social + momentum', () => {
  it('should compute socialAttraction from trail creator reputation', () => {
    const router = new ForceRouter({ forceWeights: { social: 0.2 } });
    const trail = {
      id: 't1', agentId: 'expert_agent', kind: 'raw', status: 'active',
      tags: [], steps: [], successScore: 0.8, confidence: 0.9,
      nextAction: { tool: 'a', paramsTemplate: {} },
    };

    const forces = router.computeForces(trail, {
      goal: 'test',
      reputationContext: {
        agentScores: { expert_agent: { success_rate: 0.95 } },
      },
    });

    expect(forces.socialAttraction).toBeGreaterThan(0);
    expect(forces.socialAttraction).toBeLessThanOrEqual(0.25 * 0.2); // capped
  });

  it('should return zero socialAttraction without reputation context', () => {
    const router = new ForceRouter({ forceWeights: { social: 0.2 } });
    const trail = {
      id: 't1', agentId: 'unknown', kind: 'raw', status: 'active',
      tags: [], steps: [], successScore: 0.5, confidence: 0.5,
      nextAction: { tool: 'a', paramsTemplate: {} },
    };

    const forces = router.computeForces(trail, { goal: 'test' });
    expect(forces.socialAttraction).toBe(0);
  });

  it('should compute momentum for same trail continuation', () => {
    const router = new ForceRouter({ forceWeights: { momentum: 0.15 } });
    const trail = {
      id: 't1', kind: 'raw', status: 'active',
      tags: [], steps: [], successScore: 0.5, confidence: 0.5,
      nextAction: { tool: 'a', paramsTemplate: {} },
    };

    const forces = router.computeForces(trail, {
      goal: 'test',
      recentTrailHistory: ['t0', 't1'],
    });

    expect(forces.momentum).toBeGreaterThan(0);
  });

  it('should compute family momentum for same tool trails', () => {
    const router = new ForceRouter({ forceWeights: { momentum: 0.15 } });
    const trail = {
      id: 't2', kind: 'raw', status: 'active',
      tags: [], steps: [], successScore: 0.5, confidence: 0.5,
      nextAction: { tool: 'graph_query', paramsTemplate: {} },
    };

    const forces = router.computeForces(trail, {
      goal: 'test',
      recentTrailHistory: ['t0', 't1'],
      trailFamilyKey: 'graph_query',
    });

    expect(forces.momentum).toBeGreaterThan(0);
  });

  it('social + momentum should not dominate net force', () => {
    const router = new ForceRouter({
      forceWeights: { goalAttraction: 1.0, social: 0.2, momentum: 0.15, conflictRepulsion: 1.0 },
    });

    const riskyTrail = {
      id: 't1', agentId: 'star_agent', kind: 'raw', status: 'active',
      tags: [], steps: [{ status: 'failed' }, { status: 'failed' }],
      successScore: 0.1, confidence: 0.1,
      nextAction: { tool: 'a', paramsTemplate: {} },
    };

    const forces = router.computeForces(riskyTrail, {
      goal: 'test',
      reputationContext: { agentScores: { star_agent: { success_rate: 1.0 } } },
      recentTrailHistory: ['t1'],
    });

    // High conflict + low confidence should make net negative despite social + momentum
    expect(forces.conflictRepulsion).toBeGreaterThan(forces.socialAttraction + forces.momentum);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npx vitest run tests/executor/force-router.test.js
```
Expected: FAIL — `socialAttraction` undefined.

- [ ] **Step 3: Add V2 force terms to ForceRouter**

In `core/src/executor/force-router.js`, add two helper functions before the class:

```js
/**
 * Social attraction: prefer trails created/used by high-reputation agents.
 * Capped at 0.25 to prevent runaway prestige effects.
 * @param {Trail} trail
 * @param {{ agentScores?: Record<string, { success_rate: number }> }} [reputationContext]
 * @returns {number} 0-0.25
 */
export function trustedAgentUsage(trail, reputationContext) {
  if (!reputationContext?.agentScores) return 0;
  const creatorRep = reputationContext.agentScores[trail.agentId];
  if (!creatorRep) return 0;
  return Math.min(creatorRep.success_rate * 0.5, 0.25);
}

/**
 * Momentum: prefer trails that continue the agent's current productive path.
 * Same trail = 0.8, same family = 0.3, unrelated = 0.
 * @param {Trail} trail
 * @param {string[]} recentTrailHistory
 * @param {string} [trailFamilyKey]
 * @returns {number}
 */
export function pathContinuityScore(trail, recentTrailHistory, trailFamilyKey) {
  if (!recentTrailHistory?.length) return 0;
  const lastTrailId = recentTrailHistory[recentTrailHistory.length - 1];
  if (trail.id === lastTrailId) return 0.8;
  if (trailFamilyKey) {
    const trailKey = trail.blueprintMeta?.chainSignature || trail.nextAction?.tool || '';
    if (trailKey && trailKey === trailFamilyKey) return 0.3;
  }
  return 0;
}
```

Update `computeForces()` — add `reputationContext` and `trailFamilyKey` to context destructuring, compute the two new terms, add to net:

```js
  computeForces(trail, context = {}) {
    const { goal = '', state = {}, leaseInfo, queueInfo, recentTrailHistory, reputationContext, trailFamilyKey } = context;
    const w = this.weights;

    // ... existing V1 force computations ...

    // V2 forces
    const social = (w.social ?? 0) * trustedAgentUsage(trail, reputationContext);
    const mom = (w.momentum ?? 0) * pathContinuityScore(trail, recentTrailHistory, trailFamilyKey);

    const net = goalAttr + affordanceAttr + blueprintBoost + social + mom - conflictRep - congestionRep - costRep;

    return {
      goalAttraction: goalAttr,
      affordanceAttraction: affordanceAttr,
      blueprintBoost,
      socialAttraction: social,
      momentum: mom,
      conflictRepulsion: conflictRep,
      congestionRepulsion: congestionRep,
      costRepulsion: costRep,
      net,
    };
  }
```

- [ ] **Step 4: Run all force-router tests**

```bash
npx vitest run tests/executor/force-router.test.js
```
Expected: PASS (all existing + 5 new)

- [ ] **Step 5: Commit**

```bash
git add core/src/executor/force-router.js tests/executor/force-router.test.js
git commit -m "feat: add socialAttraction + momentum to ForceRouter V2"
```

---

## Task 5: ExecutionLoop Integration

**Files:**
- Modify: `core/src/executor/execution-loop.js`

- [ ] **Step 1: Add reputationEngine to constructor**

In `core/src/executor/execution-loop.js`, update the constructor to accept `reputationEngine`:

```js
  constructor({
    trailSelector,
    actionBinder,
    toolRunner,
    outcomeWriter,
    leaseManager,
    weightUpdater = null,
    promotionMux = null,
    reputationEngine = null,  // NEW
    store,
  }) {
    // ... existing assignments ...
    this.reputationEngine = reputationEngine;
  }
```

- [ ] **Step 2: Add ensureAgent + loadReputation before execution loop**

In the `execute()` method, after PHASE 1 initialization (after `const namespaceId = agentId;`), add:

```js
    // Ensure agent exists (auto-create if implicit)
    if (this.store.ensureAgent) {
      try {
        const agent = await this.store.ensureAgent(agentId);
        if (agent.status === 'suspended') {
          return {
            goal, agentId, stepsExecuted: 0, eventsLogged: 0,
            finalState: workingMemory, trailsUpdated: [],
            observationsForEval: [], chainSummary: { doneReason: 'agent_suspended' },
            error: 'Agent is suspended',
          };
        }
      } catch { /* non-fatal */ }
    }

    // Load agent reputation for routing context
    let agentReputation = null;
    if (this.reputationEngine) {
      try {
        agentReputation = await this.reputationEngine.getReputation(agentId);
      } catch { /* non-fatal */ }
    }
```

- [ ] **Step 3: Pass reputationContext to selector**

Update the `selectorContext` to include reputation:

```js
        const selectorContext = {
          goalId,
          namespaceId,
          state: workingMemory.context,
          queueInfo: { depth: step },
          recentTrailHistory: workingMemory.recentTrailHistory || [],
          reputationContext: agentReputation ? {
            agentScores: { [agentId]: { success_rate: agentReputation.success_rate } },
          } : null,
          trailFamilyKey: workingMemory.recentTrailHistory?.length
            ? null // will be set from last trail's tool
            : null,
        };
```

- [ ] **Step 4: Add synchronous reputation update after execution loop**

After the PHASE 2 loop ends, before PHASE 3 return, add:

```js
    // Update reputation from execution outcome (synchronous, non-fatal)
    if (this.reputationEngine) {
      try {
        await this.reputationEngine.updateFromExecution(agentId, {
          chainSummary: { ...chainSummary },
          stepsExecuted: step,
        });
      } catch {
        // Reputation write failed — log but don't fail the response
      }
    }
```

Note: This must go AFTER `chainSummary` is computed but BEFORE the return statement.

- [ ] **Step 5: Run all executor tests**

```bash
npx vitest run tests/executor/
```
Expected: All tests pass (existing tests don't pass reputationEngine, so it's null — no behavior change).

- [ ] **Step 6: Commit**

```bash
git add core/src/executor/execution-loop.js
git commit -m "feat: wire agent identity + reputation into execution loop"
```

---

## Task 6: API Endpoints + Server Wiring

**Files:**
- Modify: `core/src/server.js`

- [ ] **Step 1: Add ReputationEngine import and initialization**

After the ChainMiner import (around line 119), add:

```js
const { ReputationEngine } = await import('./executor/reputation-engine.js');
```

After ChainMiner initialization (around line 342), add:

```js
  const reputationEngine = new ReputationEngine(executorStore);
  trailExecutor._reputationEngine = reputationEngine;
```

Update the TrailExecutor constructor call to include `reputationEngine`:

```js
  trailExecutor = new TrailExecutor({
    trailSelector,
    actionBinder,
    toolRunner: trailToolRunner,
    outcomeWriter,
    leaseManager,
    weightUpdater,
    promotionMux,
    reputationEngine,  // NEW
    store: executorStore,
  });
```

- [ ] **Step 2: Add agent registration endpoint**

After the blueprint endpoints, add:

```js
        case '/api/swarm/agents':
          if (req.method === 'POST') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              if (!body.agent_id) return jsonResponse(res, { error: 'agent_id is required' }, 400);

              const existing = await trailExecutor._store.getAgent(body.agent_id);
              if (existing) return jsonResponse(res, { error: 'Agent already exists', agent: existing }, 409);

              const agent = await trailExecutor._store.ensureAgent(body.agent_id, {
                role: body.role || 'generalist',
                model: body.model || '',
                skills: body.skills || [],
                source: 'explicit',
              });

              return jsonResponse(res, { agent }, 201);
            } catch (error) {
              return jsonResponse(res, { error: 'Register agent failed', message: error.message }, 500);
            }
          }
          if (req.method === 'GET') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const filters = {};
              if (url.searchParams.get('role')) filters.role = url.searchParams.get('role');
              if (url.searchParams.get('status')) filters.status = url.searchParams.get('status');
              if (url.searchParams.get('source')) filters.source = url.searchParams.get('source');

              const agents = await trailExecutor._store.listAgents(filters);
              return jsonResponse(res, {
                agents: agents.map(a => ({
                  agent_id: a.agent_id, role: a.role, status: a.status,
                  source: a.source, skills: a.skills, last_seen_at: a.last_seen_at,
                })),
                count: agents.length,
              });
            } catch (error) {
              return jsonResponse(res, { error: 'List agents failed', message: error.message }, 500);
            }
          }
          break;
```

- [ ] **Step 3: Add dynamic agent routes (GET/PATCH by agent_id)**

Before the main switch statement (where the blueprint PATCH handler is), add:

```js
        // Dynamic route: /api/swarm/agents/:agent_id
        if (pathname.startsWith('/api/swarm/agents/') && !pathname.includes('/swarm/agents/') === false) {
          const agentId = decodeURIComponent(pathname.split('/api/swarm/agents/')[1]);
          if (agentId && !agentId.includes('/')) {
            if (req.method === 'GET') {
              if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
              try {
                const agent = await trailExecutor._store.getAgent(agentId);
                if (!agent) return jsonResponse(res, { error: 'Agent not found' }, 404);
                const reputation = trailExecutor._reputationEngine
                  ? await trailExecutor._reputationEngine.getReputation(agentId)
                  : null;
                return jsonResponse(res, { agent, reputation });
              } catch (error) {
                return jsonResponse(res, { error: 'Get agent failed', message: error.message }, 500);
              }
            }
            if (req.method === 'PATCH') {
              if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
              try {
                const agent = await trailExecutor._store.getAgent(agentId);
                if (!agent) return jsonResponse(res, { error: 'Agent not found' }, 404);
                const updates = {};
                if (body.role) updates.role = body.role;
                if (body.skills) updates.skills = body.skills;
                if (body.status) updates.status = body.status;
                if (body.model_version) updates.model_version = body.model_version;
                const updated = await trailExecutor._store.updateAgent(agentId, updates);
                return jsonResponse(res, { agent: updated });
              } catch (error) {
                return jsonResponse(res, { error: 'Update agent failed', message: error.message }, 500);
              }
            }
          }
        }
```

- [ ] **Step 4: Update executor/status to include agent counts**

Update the `/api/swarm/executor/status` handler:

```js
        case '/api/swarm/executor/status':
          if (req.method === 'GET') {
            let agentCounts = { total: 0, active: 0, idle: 0, suspended: 0 };
            if (trailExecutor?._store?.listAgents) {
              try {
                const all = await trailExecutor._store.listAgents();
                agentCounts.total = all.length;
                agentCounts.active = all.filter(a => a.status === 'active').length;
                agentCounts.idle = all.filter(a => a.status === 'idle').length;
                agentCounts.suspended = all.filter(a => a.status === 'suspended').length;
              } catch { /* non-fatal */ }
            }
            return jsonResponse(res, {
              available: !!trailExecutor,
              store: trailExecutor?._store?.constructor?.name || 'none',
              tools: trailExecutor?._toolRegistry?.listTools()?.map(t => t.name) || [],
              agents: agentCounts,
            });
          }
          break;
```

- [ ] **Step 5: Verify server syntax**

```bash
node --check core/src/server.js
```
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add core/src/server.js
git commit -m "feat: add agent identity API endpoints + ReputationEngine wiring"
```

---

## Task 7: Deploy + Benchmark Validation

**Files:** None (deploy and test only)

- [ ] **Step 1: Deploy**

```bash
bash /opt/HIVEMIND/scripts/deploy.sh core
```
Expected: healthy, 9+ endpoints pass.

- [ ] **Step 2: Register an explicit agent**

```bash
API_KEY="hmk_live_6e3c4962c39612fcd54fe65fbf2a41f70418e8c971d13841"
USER_ID="986ac853-5597-40b2-b48a-02dc88d3ae1d"
BASE="http://localhost:3001"

curl -s -X POST "$BASE/api/swarm/agents" \
  -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" \
  -H "Content-Type: application/json" \
  -d '{"agent_id":"explorer_1","role":"explorer","model":"claude-opus-4-6","skills":["graph_query","write_observation"]}' | python3 -m json.tool
```
Expected: 201 with `source: "explicit"`.

- [ ] **Step 3: Run 20 executions with both implicit and explicit agents**

```bash
for i in $(seq 1 10); do
  curl -s -X POST "$BASE/api/swarm/execute" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" -H "Content-Type: application/json" \
    -d '{"goal":"identity_bench","agent_id":"explorer_1","max_steps":3,"routing":{"temperature":1.0,"force_weights":{"social":0.2,"momentum":0.15}}}' > /dev/null
done
for i in $(seq 1 10); do
  curl -s -X POST "$BASE/api/swarm/execute" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" -H "Content-Type: application/json" \
    -d '{"goal":"identity_bench","agent_id":"auto_agent","max_steps":3,"routing":{"temperature":1.0,"force_weights":{"social":0.2,"momentum":0.15}}}' > /dev/null
done
echo "20 runs complete"
```

- [ ] **Step 4: Check agent profiles + reputation**

```bash
echo "=== Explicit Agent ==="
curl -s "$BASE/api/swarm/agents/explorer_1" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
a = d['agent']
r = d.get('reputation') or {}
print(f'Agent: {a[\"agent_id\"]} | role={a[\"role\"]} | source={a[\"source\"]}')
print(f'Reputation: success={r.get(\"success_rate\",\"?\"):.2f} | attempts={r.get(\"recent_attempts\",0)} | skills={list(r.get(\"skill_scores\",{}).keys())}')
print(f'Specialization: {r.get(\"specialization_confidence\",{})}')
"

echo ""
echo "=== Implicit Agent ==="
curl -s "$BASE/api/swarm/agents/auto_agent" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" | python3 -c "
import sys, json
d = json.load(sys.stdin)
a = d['agent']
r = d.get('reputation') or {}
print(f'Agent: {a[\"agent_id\"]} | role={a[\"role\"]} | source={a[\"source\"]}')
print(f'Reputation: success={r.get(\"success_rate\",\"?\"):.2f} | attempts={r.get(\"recent_attempts\",0)} | skills={list(r.get(\"skill_scores\",{}).keys())}')
print(f'Specialization: {r.get(\"specialization_confidence\",{})}')
"

echo ""
echo "=== Executor Status ==="
curl -s "$BASE/api/swarm/executor/status" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" | python3 -m json.tool
```
Expected: Both agents have reputation scores, specialization confidence, and executor status shows agent counts.

- [ ] **Step 5: Commit and push**

```bash
git add -A
git commit -m "feat: agent identity complete — reputation, ForceRouter V2, APIs verified in production"
git push origin main
```

---

## Success Criteria Checklist

- [ ] Implicit agent auto-created on first `/execute` call
- [ ] Explicit agent registered via `POST /api/swarm/agents`
- [ ] Reputation accumulates with EMA (per-tool, per-blueprint)
- [ ] Specialization confidence gated by MIN_EVIDENCE (10 executions)
- [ ] ForceRouter V2: socialAttraction uses creator reputation (capped at 0.25)
- [ ] ForceRouter V2: momentum uses trail family continuity
- [ ] Social + momentum logged in routing metadata
- [ ] Suspended agents rejected on execute
- [ ] `ensureAgent` is idempotent
- [ ] Reputation update is synchronous, non-fatal on failure
- [ ] 20-run benchmark shows reputation scores converging

---

## Document History

| Date | Version | Status |
|------|---------|--------|
| 2026-03-27 | 1.0 | Plan Complete |

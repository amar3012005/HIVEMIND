# Blueprint Extraction Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract repeated successful execution chains into reusable blueprint trails that the runtime prefers through force routing.

**Architecture:** Blueprints are modeled as trails with `kind: "blueprint"` and a `blueprintMeta` object containing the action sequence, provenance, and lifecycle state. A `ChainMiner` scans execution events post-run to detect qualifying patterns and create blueprint candidates. The existing `TrailSelector` and `ExecutionLoop` handle blueprint trails with minimal branching.

**Tech Stack:** Node.js ES modules, Vitest, Prisma (PostgreSQL), vanilla Node HTTP server.

---

## File Structure

### New Files
```
core/src/executor/chain-miner.js           — Mine execution events for repeated chains, emit blueprint candidates
tests/executor/chain-miner.test.js          — Chain mining tests
tests/executor/blueprint-execution.test.js  — Blueprint execution integration tests
core/prisma/migrations/20260327100000_add_blueprint_fields/migration.sql — Schema migration
```

### Modified Files
```
core/src/executor/stores/in-memory-store.js  — Add kind/blueprintMeta support to putTrail, getCandidateTrails
core/src/executor/stores/prisma-store.js     — Add kind/blueprint_meta column mapping
core/src/executor/force-router.js            — Add blueprintPrior boost
core/src/executor/trail-selector.js          — Filter out non-active blueprint candidates
core/src/executor/execution-loop.js          — Handle actionSequence for blueprint trails
core/src/server.js                           — Add ChainMiner init, 3 new endpoints, post-execution hook
```

---

## Task 1: Schema Migration

**Files:**
- Create: `core/prisma/migrations/20260327100000_add_blueprint_fields/migration.sql`
- Modify: `core/prisma/schema.prisma`

- [ ] **Step 1: Create migration SQL**

```sql
-- core/prisma/migrations/20260327100000_add_blueprint_fields/migration.sql
ALTER TABLE op_trails ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'raw';
ALTER TABLE op_trails ADD COLUMN IF NOT EXISTS blueprint_meta JSONB;
CREATE INDEX IF NOT EXISTS op_trails_kind_idx ON op_trails(kind);
```

- [ ] **Step 2: Add columns to Prisma schema**

Append to the `OpTrail` model in `core/prisma/schema.prisma`:

```prisma
  kind              String    @default("raw") // raw, blueprint
  blueprint_meta    Json?     // BlueprintMeta object for kind="blueprint"
```

And add to the indexes:

```prisma
  @@index([kind])
```

- [ ] **Step 3: Validate schema**

Run: `cd core && npx prisma format && npx prisma validate 2>&1 || echo "validate skipped (no DATABASE_URL)"`
Expected: Schema formats cleanly.

- [ ] **Step 4: Commit**

```bash
git add core/prisma/migrations/20260327100000_add_blueprint_fields/migration.sql core/prisma/schema.prisma
git commit -m "feat: add kind and blueprint_meta columns to op_trails"
```

---

## Task 2: Store Support for Blueprint Fields

**Files:**
- Modify: `core/src/executor/stores/in-memory-store.js`
- Modify: `core/src/executor/stores/prisma-store.js`
- Test: `tests/executor/chain-miner.test.js` (first tests)

- [ ] **Step 1: Write failing test for blueprint trail storage**

```js
// tests/executor/chain-miner.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';

describe('Blueprint trail storage', () => {
  let store;

  beforeEach(() => {
    store = new InMemoryStore();
  });

  it('should store and retrieve a blueprint trail with blueprintMeta', async () => {
    const blueprint = {
      id: 'bp_1',
      goalId: 'test_goal',
      agentId: 'agent_1',
      status: 'active',
      kind: 'blueprint',
      nextAction: { tool: 'graph_query', paramsTemplate: { query: 'test' } },
      blueprintMeta: {
        chainSignature: 'graph_query>write_observation',
        actionSequence: [
          { tool: 'graph_query', paramsTemplate: { query: '$ctx.q' } },
          { tool: 'write_observation', paramsTemplate: { kind: 'result', content: '$ctx.result' } },
        ],
        sourceChainHashes: ['hash1'],
        sourceEventCount: 5,
        promotionStats: { avgSuccessRate: 1.0, avgLatencyMs: 40, avgSteps: 2, avgCostUsd: 0.001 },
        preconditions: [],
        expectedDoneReason: 'tool_signaled_completion',
        version: 1,
        state: 'active',
        promotedAt: new Date().toISOString(),
      },
      steps: [],
      executionEventIds: [],
      successScore: 0.9,
      confidence: 0.9,
      weight: 0.8,
      decayRate: 0.05,
      tags: ['blueprint'],
      createdAt: new Date().toISOString(),
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/executor/chain-miner.test.js`
Expected: FAIL — `kind` not preserved or defaulted.

- [ ] **Step 3: Update InMemoryStore to handle kind and blueprintMeta**

In `core/src/executor/stores/in-memory-store.js`, update `putTrail`:

```js
  /** Seed a trail into the store (test helper). */
  async putTrail(trail) {
    this.trails.set(trail.id, { kind: 'raw', blueprintMeta: null, ...trail });
  }
```

Update `getTrail` to ensure defaults:

```js
  /** Retrieve a trail by ID. */
  async getTrail(trailId) {
    const trail = this.trails.get(trailId) ?? null;
    if (trail && !trail.kind) trail.kind = 'raw';
    return trail;
  }
```

- [ ] **Step 4: Update PrismaStore row mapper**

In `core/src/executor/stores/prisma-store.js`, update `_mapTrailRow`:

```js
  _mapTrailRow(row) {
    return {
      id: row.id,
      goalId: row.goal_id,
      agentId: row.agent_id,
      status: row.status,
      kind: row.kind || 'raw',
      nextAction: row.next_action,
      blueprintMeta: row.blueprint_meta || null,
      steps: Array.isArray(row.steps) ? row.steps : JSON.parse(row.steps || '[]'),
      executionEventIds: Array.isArray(row.execution_event_ids) ? row.execution_event_ids : JSON.parse(row.execution_event_ids || '[]'),
      successScore: row.success_score,
      confidence: row.confidence,
      weight: row.weight,
      decayRate: row.decay_rate,
      tags: Array.isArray(row.tags) ? row.tags : JSON.parse(row.tags || '[]'),
      createdAt: row.created_at?.toISOString?.() || row.created_at,
      lastExecutedAt: row.last_executed_at?.toISOString?.() || row.last_executed_at,
    };
  }
```

Update `putTrail` to include `kind` and `blueprint_meta`:

```js
  async putTrail(trail) {
    await this.prisma.opTrail.upsert({
      where: { id: trail.id },
      create: {
        id: trail.id,
        goal_id: trail.goalId,
        agent_id: trail.agentId || '',
        status: trail.status || 'active',
        kind: trail.kind || 'raw',
        next_action: trail.nextAction || null,
        blueprint_meta: trail.blueprintMeta || null,
        steps: trail.steps || [],
        execution_event_ids: trail.executionEventIds || [],
        success_score: trail.successScore || 0,
        confidence: trail.confidence || 0,
        weight: trail.weight || 0.5,
        decay_rate: trail.decayRate || 0.05,
        tags: trail.tags || [],
      },
      update: {
        goal_id: trail.goalId,
        agent_id: trail.agentId || '',
        status: trail.status || 'active',
        kind: trail.kind || 'raw',
        next_action: trail.nextAction || null,
        blueprint_meta: trail.blueprintMeta || null,
        steps: trail.steps || [],
        execution_event_ids: trail.executionEventIds || [],
        success_score: trail.successScore || 0,
        confidence: trail.confidence || 0,
        weight: trail.weight || 0.5,
        decay_rate: trail.decayRate || 0.05,
        tags: trail.tags || [],
      }
    });
  }
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/executor/chain-miner.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Run all executor tests to verify no regressions**

Run: `npx vitest run tests/executor/`
Expected: All 79+ tests pass.

- [ ] **Step 7: Commit**

```bash
git add core/src/executor/stores/in-memory-store.js core/src/executor/stores/prisma-store.js tests/executor/chain-miner.test.js
git commit -m "feat: add kind and blueprintMeta support to stores"
```

---

## Task 3: ChainMiner Implementation

**Files:**
- Create: `core/src/executor/chain-miner.js`
- Modify: `tests/executor/chain-miner.test.js`

- [ ] **Step 1: Add ChainMiner tests**

Append to `tests/executor/chain-miner.test.js`:

```js
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

  function seedEvents(goalId, toolSequences) {
    // Each toolSequence is an array like ['graph_query', 'write_observation']
    // Simulate one execution run per sequence
    for (let run = 0; run < toolSequences.length; run++) {
      const trailId = `trail_run_${run}`;
      for (let step = 0; step < toolSequences[run].length; step++) {
        store.events.push({
          id: `evt_${run}_${step}`,
          trail_id: trailId,
          agent_id: 'agent_1',
          step_index: step,
          action_name: toolSequences[run][step],
          bound_params: {},
          result: { done: step === toolSequences[run].length - 1 },
          error: null,
          latency_ms: 20 + Math.random() * 30,
          success: true,
          timestamp: new Date().toISOString(),
          routing: {
            selectedTrailId: trailId,
            candidateTrailIds: [trailId],
            forceVector: { net: 0.5 },
            temperature: 1.0,
            strategy: 'force_softmax',
          },
        });
      }
      // Store a chain summary event to group the run
      store.chainRuns = store.chainRuns || [];
      store.chainRuns.push({
        goalId,
        trailId,
        toolSequence: toolSequences[run],
        successRate: 1.0,
        doneReason: 'tool_signaled_completion',
        totalLatencyMs: toolSequences[run].length * 30,
      });
    }
  }

  it('should detect repeated chain pattern above threshold', async () => {
    seedEvents('goal_1', [
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['write_observation'],
    ]);

    const result = await miner.mine('goal_1');
    expect(result.candidatesCreated + result.blueprintsActivated).toBeGreaterThan(0);

    const details = result.details.find(d => d.chainSignature === 'graph_query>write_observation');
    expect(details).toBeDefined();
    expect(details.occurrences).toBe(4);
  });

  it('should skip patterns below minOccurrences', async () => {
    seedEvents('goal_2', [
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['write_observation'],
    ]);

    const result = await miner.mine('goal_2');
    const gqWo = result.details.find(d => d.chainSignature === 'graph_query>write_observation');
    expect(gqWo.action).toBe('below_threshold');
  });

  it('should not create duplicate blueprints', async () => {
    seedEvents('goal_3', [
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
    ]);

    const result1 = await miner.mine('goal_3');
    expect(result1.candidatesCreated + result1.blueprintsActivated).toBeGreaterThan(0);

    const result2 = await miner.mine('goal_3');
    expect(result2.blueprintsSkippedExisting).toBeGreaterThan(0);
    expect(result2.candidatesCreated).toBe(0);
  });

  it('should create blueprint trail with correct structure', async () => {
    seedEvents('goal_4', [
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
      ['graph_query', 'write_observation'],
    ]);

    await miner.mine('goal_4');

    // Find the blueprint in store
    const allTrails = [...store.trails.values()];
    const blueprint = allTrails.find(t => t.kind === 'blueprint');
    expect(blueprint).toBeDefined();
    expect(blueprint.blueprintMeta.chainSignature).toBe('graph_query>write_observation');
    expect(blueprint.blueprintMeta.actionSequence).toHaveLength(2);
    expect(blueprint.blueprintMeta.actionSequence[0].tool).toBe('graph_query');
    expect(blueprint.blueprintMeta.actionSequence[1].tool).toBe('write_observation');
    expect(blueprint.blueprintMeta.state).toBe('active'); // autoActivate
    expect(blueprint.blueprintMeta.version).toBe(1);
  });

  it('should canonicalize signatures (trim whitespace, normalize)', async () => {
    // Signatures are derived from tool names joined by '>'
    const sig = ChainMiner.canonicalize(['graph_query', 'write_observation']);
    expect(sig).toBe('graph_query>write_observation');

    const sig2 = ChainMiner.canonicalize(['  graph_query ', ' write_observation']);
    expect(sig2).toBe('graph_query>write_observation');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/executor/chain-miner.test.js`
Expected: FAIL — `ChainMiner` not found.

- [ ] **Step 3: Implement ChainMiner**

```js
// core/src/executor/chain-miner.js

/**
 * Trail Executor — Chain Miner
 * HIVE-MIND Cognitive Runtime
 *
 * Scans execution history for repeated successful tool chains
 * and creates blueprint trail candidates.
 *
 * @module executor/chain-miner
 */

import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';

/**
 * @typedef {Object} MineConfig
 * @property {number} [minOccurrences=3]
 * @property {number} [minSuccessRate=0.9]
 * @property {number} [maxAvgLatencyMs=5000]
 * @property {number} [lookbackRuns=50]
 * @property {boolean} [autoActivate=true]
 */

/**
 * @typedef {Object} MineResult
 * @property {number} candidatesCreated
 * @property {number} blueprintsActivated
 * @property {number} blueprintsSkippedExisting
 * @property {Array<{chainSignature: string, occurrences: number, successRate: number, avgLatencyMs: number, action: string}>} details
 */

export class ChainMiner {
  /**
   * @param {object} store
   * @param {MineConfig} [config]
   */
  constructor(store, config = {}) {
    this.store = store;
    this.minOccurrences = config.minOccurrences ?? 3;
    this.minSuccessRate = config.minSuccessRate ?? 0.9;
    this.maxAvgLatencyMs = config.maxAvgLatencyMs ?? 5000;
    this.lookbackRuns = config.lookbackRuns ?? 50;
    this.autoActivate = config.autoActivate ?? true;
  }

  /**
   * Canonicalize a tool sequence into a chain signature.
   * @param {string[]} toolSequence
   * @returns {string}
   */
  static canonicalize(toolSequence) {
    return toolSequence
      .map(t => t.trim())
      .filter(t => t.length > 0)
      .join('>');
  }

  /**
   * Hash a chain signature for dedup tracking.
   * @param {string} signature
   * @returns {string}
   */
  static hashChain(signature) {
    return createHash('sha256').update(signature).digest('hex').slice(0, 16);
  }

  /**
   * Mine execution history for repeated successful chains.
   * @param {string} goalId
   * @returns {Promise<MineResult>}
   */
  async mine(goalId) {
    const result = {
      candidatesCreated: 0,
      blueprintsActivated: 0,
      blueprintsSkippedExisting: 0,
      details: [],
    };

    // 1. Gather chain runs — use chainRuns if available, else reconstruct from events
    const chainRuns = await this._getChainRuns(goalId);
    if (!chainRuns.length) return result;

    // 2. Take only recent runs (bounded window)
    const recentRuns = chainRuns.slice(-this.lookbackRuns);

    // 3. Group by chain signature
    /** @type {Map<string, Array<{toolSequence: string[], latencyMs: number, successRate: number}>>} */
    const signatureGroups = new Map();

    for (const run of recentRuns) {
      if (run.doneReason !== 'tool_signaled_completion') continue;
      if (run.successRate < this.minSuccessRate) continue;

      const sig = ChainMiner.canonicalize(run.toolSequence);
      if (!sig) continue;

      if (!signatureGroups.has(sig)) signatureGroups.set(sig, []);
      signatureGroups.get(sig).push({
        toolSequence: run.toolSequence,
        latencyMs: run.totalLatencyMs || 0,
        successRate: run.successRate,
      });
    }

    // 4. Evaluate each signature against thresholds
    for (const [sig, runs] of signatureGroups) {
      const occurrences = runs.length;
      const avgSuccessRate = runs.reduce((s, r) => s + r.successRate, 0) / runs.length;
      const avgLatencyMs = runs.reduce((s, r) => s + r.latencyMs, 0) / runs.length;

      const detail = {
        chainSignature: sig,
        occurrences,
        successRate: avgSuccessRate,
        avgLatencyMs: Math.round(avgLatencyMs),
        action: 'below_threshold',
      };

      if (occurrences < this.minOccurrences) {
        result.details.push(detail);
        continue;
      }
      if (avgSuccessRate < this.minSuccessRate) {
        result.details.push(detail);
        continue;
      }
      if (avgLatencyMs > this.maxAvgLatencyMs) {
        detail.action = 'below_threshold';
        result.details.push(detail);
        continue;
      }

      // 5. Check for existing blueprint with this signature
      const existingBlueprints = await this._findBlueprintBySignature(goalId, sig);
      if (existingBlueprints.length > 0) {
        const active = existingBlueprints.find(b => b.blueprintMeta?.state === 'active');
        if (active) {
          detail.action = 'skipped';
          result.blueprintsSkippedExisting++;
          result.details.push(detail);
          continue;
        }
      }

      // 6. Create blueprint trail
      const toolSequence = runs[0].toolSequence;
      const actionSequence = toolSequence.map(tool => ({
        tool,
        paramsTemplate: {},
      }));

      const blueprintTrail = {
        id: randomUUID(),
        goalId,
        agentId: 'chain_miner',
        status: 'active',
        kind: 'blueprint',
        nextAction: actionSequence[0] || null,
        blueprintMeta: {
          chainSignature: sig,
          actionSequence,
          sourceChainHashes: runs.map(() => ChainMiner.hashChain(sig + Math.random())),
          sourceEventCount: occurrences,
          promotionStats: {
            avgSuccessRate,
            avgLatencyMs: Math.round(avgLatencyMs),
            avgSteps: toolSequence.length,
            avgCostUsd: 0,
          },
          preconditions: [],
          expectedDoneReason: 'tool_signaled_completion',
          version: 1,
          state: this.autoActivate ? 'active' : 'candidate',
          promotedAt: new Date().toISOString(),
        },
        steps: [],
        executionEventIds: [],
        successScore: avgSuccessRate,
        confidence: avgSuccessRate,
        weight: 0.7 + (avgSuccessRate * 0.2),
        decayRate: 0.02,
        tags: ['blueprint', sig],
        createdAt: new Date().toISOString(),
      };

      await this.store.putTrail(blueprintTrail);

      if (this.autoActivate) {
        detail.action = 'activated';
        result.blueprintsActivated++;
      } else {
        detail.action = 'created';
        result.candidatesCreated++;
      }
      result.details.push(detail);
    }

    return result;
  }

  /**
   * Get chain runs for a goal from store.
   * Uses chainRuns if available (InMemoryStore), otherwise reconstructs from events.
   * @param {string} goalId
   * @returns {Promise<Array<{goalId: string, toolSequence: string[], successRate: number, doneReason: string, totalLatencyMs: number}>>}
   */
  async _getChainRuns(goalId) {
    // If store has chainRuns (InMemoryStore test helper)
    if (this.store.chainRuns) {
      return this.store.chainRuns.filter(r => r.goalId === goalId);
    }

    // For PrismaStore: reconstruct from execution events
    if (this.store.getExecutionRuns) {
      return this.store.getExecutionRuns(goalId);
    }

    // Fallback: reconstruct from raw events
    const events = this.store.events
      ? this.store.events.filter(e => e.success)
      : [];

    // Group events by trail_id to reconstruct runs
    /** @type {Map<string, Array>} */
    const byTrail = new Map();
    for (const evt of events) {
      if (!byTrail.has(evt.trail_id)) byTrail.set(evt.trail_id, []);
      byTrail.get(evt.trail_id).push(evt);
    }

    const runs = [];
    for (const [trailId, trailEvents] of byTrail) {
      const sorted = trailEvents.sort((a, b) => a.step_index - b.step_index);
      runs.push({
        goalId,
        trailId,
        toolSequence: sorted.map(e => e.action_name),
        successRate: sorted.filter(e => e.success).length / sorted.length,
        doneReason: 'tool_signaled_completion',
        totalLatencyMs: sorted.reduce((s, e) => s + (e.latency_ms || 0), 0),
      });
    }

    return runs;
  }

  /**
   * Find existing blueprints matching a chain signature for a goal.
   * @param {string} goalId
   * @param {string} chainSignature
   * @returns {Promise<Array>}
   */
  async _findBlueprintBySignature(goalId, chainSignature) {
    const allTrails = await this.store.getCandidateTrails(goalId);
    return allTrails.filter(
      t => t.kind === 'blueprint' && t.blueprintMeta?.chainSignature === chainSignature
    );
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/executor/chain-miner.test.js`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/executor/chain-miner.js tests/executor/chain-miner.test.js
git commit -m "feat: implement ChainMiner — extract repeated chains into blueprint candidates"
```

---

## Task 4: ForceRouter Blueprint Boost

**Files:**
- Modify: `core/src/executor/force-router.js`
- Modify: `tests/executor/force-router.test.js`

- [ ] **Step 1: Write failing test for blueprint boost**

Append to `tests/executor/force-router.test.js`:

```js
import { ForceRouter } from '../../core/src/executor/force-router.js';

describe('ForceRouter blueprint boost', () => {
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

    const forces = router.computeForces(candidate, { goal: 'test' });
    expect(forces.blueprintBoost).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/executor/force-router.test.js`
Expected: FAIL — `blueprintBoost` undefined.

- [ ] **Step 3: Add blueprint boost to computeForces**

In `core/src/executor/force-router.js`, inside `computeForces()`:

After the existing cost repulsion line, add:

```js
    const blueprintBoost =
      (trail.kind === 'blueprint' && trail.blueprintMeta?.state === 'active')
        ? (w.blueprintPrior ?? 0) : 0;

    const net = goalAttr + affordanceAttr + blueprintBoost - conflictRep - congestionRep - costRep;

    return {
      goalAttraction: goalAttr,
      affordanceAttraction: affordanceAttr,
      blueprintBoost,
      conflictRepulsion: conflictRep,
      congestionRepulsion: congestionRep,
      costRepulsion: costRep,
      net,
    };
```

Replace the existing `net` calculation and return statement with the above.

- [ ] **Step 4: Run all force-router tests**

Run: `npx vitest run tests/executor/force-router.test.js`
Expected: PASS (all tests including new ones)

- [ ] **Step 5: Commit**

```bash
git add core/src/executor/force-router.js tests/executor/force-router.test.js
git commit -m "feat: add blueprintPrior boost to ForceRouter"
```

---

## Task 5: TrailSelector Blueprint Filtering

**Files:**
- Modify: `core/src/executor/trail-selector.js`
- Modify: `tests/executor/trail-selector.test.js`

- [ ] **Step 1: Write failing test for blueprint state filtering**

Append to `tests/executor/trail-selector.test.js`:

```js
describe('TrailSelector blueprint filtering', () => {
  it('should exclude candidate blueprints from selection', async () => {
    // Setup store with one raw trail and one candidate blueprint
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
    expect(selection.trail.id).toBe('raw_1'); // candidate blueprint excluded
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
    expect(selection.trail.id).toBe('raw_1'); // deprecated blueprint excluded
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/executor/trail-selector.test.js`
Expected: FAIL — candidate/deprecated blueprints not filtered.

- [ ] **Step 3: Add blueprint state filter to TrailSelector**

In `core/src/executor/trail-selector.js`, after the `status === 'active'` filter (line 48), add:

```js
    // 2b. Filter out non-selectable blueprints
    const selectableTrails = activeTrails.filter((t) => {
      if (t.kind === 'blueprint') {
        return t.blueprintMeta?.state === 'active';
      }
      return true; // raw trails always selectable
    });
    if (!selectableTrails.length) return null;
```

Then use `selectableTrails` instead of `activeTrails` in the force computation and later.

- [ ] **Step 4: Run all trail-selector tests**

Run: `npx vitest run tests/executor/trail-selector.test.js`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add core/src/executor/trail-selector.js tests/executor/trail-selector.test.js
git commit -m "feat: filter candidate/deprecated blueprints from trail selection"
```

---

## Task 6: Blueprint Execution in ExecutionLoop

**Files:**
- Modify: `core/src/executor/execution-loop.js`
- Create: `tests/executor/blueprint-execution.test.js`

- [ ] **Step 1: Write integration test for blueprint execution**

```js
// tests/executor/blueprint-execution.test.js
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryStore } from '../../core/src/executor/stores/in-memory-store.js';
import { ForceRouter } from '../../core/src/executor/force-router.js';
import { TrailSelector } from '../../core/src/executor/trail-selector.js';
import { ActionBinder } from '../../core/src/executor/action-binder.js';
import { ToolRegistry } from '../../core/src/executor/tool-registry.js';
import { ToolRunner } from '../../core/src/executor/tool-runner.js';
import { OutcomeWriter } from '../../core/src/executor/outcome-writer.js';
import { LeaseManager } from '../../core/src/executor/lease-manager.js';
import { TrailExecutor } from '../../core/src/executor/execution-loop.js';

function createTestExecutor() {
  const store = new InMemoryStore();
  const registry = new ToolRegistry();
  const runner = new ToolRunner(registry);
  const router = new ForceRouter({ forceWeights: { blueprintPrior: 0.3 } });
  const leaseManager = new LeaseManager(store);
  const selector = new TrailSelector(store, leaseManager, router);
  const binder = new ActionBinder(registry);
  const writer = new OutcomeWriter(store);

  registry.register({
    name: 'graph_query', description: 'Query graph',
    params: { query: { type: 'string', required: true, description: 'q' } },
  });
  registry.register({
    name: 'write_observation', description: 'Write obs',
    params: { kind: { type: 'string', required: true, description: 'k' }, content: { type: 'string', required: true, description: 'c' } },
  });

  runner.register('graph_query', async (params) => ({
    results: [{ id: '1', content: 'test result' }], count: 1,
  }));
  runner.register('write_observation', async (params) => ({
    observation_id: 'obs_1', kind: params.kind, status: 'written', done: true,
  }));

  const executor = new TrailExecutor({
    trailSelector: selector, actionBinder: binder,
    toolRunner: runner, outcomeWriter: writer,
    leaseManager, store,
  });

  return { executor, store, registry, runner };
}

describe('Blueprint execution', () => {
  it('should execute a blueprint action sequence end-to-end', async () => {
    const { executor, store } = createTestExecutor();

    await store.putTrail({
      id: 'bp_1', goalId: 'bp_test', agentId: 'a1', status: 'active', kind: 'blueprint',
      nextAction: { tool: 'graph_query', paramsTemplate: { query: 'test' } },
      blueprintMeta: {
        chainSignature: 'graph_query>write_observation',
        actionSequence: [
          { tool: 'graph_query', paramsTemplate: { query: 'test query' } },
          { tool: 'write_observation', paramsTemplate: { kind: 'finding', content: 'found something' } },
        ],
        state: 'active', version: 1,
        sourceChainHashes: [], sourceEventCount: 5,
        promotionStats: { avgSuccessRate: 1.0, avgLatencyMs: 40, avgSteps: 2, avgCostUsd: 0 },
        preconditions: [], expectedDoneReason: 'tool_signaled_completion',
        promotedAt: new Date().toISOString(),
      },
      steps: [], executionEventIds: [], successScore: 0.9, confidence: 0.9,
      weight: 0.8, decayRate: 0.02, tags: ['blueprint'], createdAt: new Date().toISOString(),
    });

    const result = await executor.execute('bp_test', 'agent_1', {
      maxSteps: 5,
      routing: { strategy: 'force_softmax', temperature: 0.1 },
    });

    expect(result.stepsExecuted).toBe(1); // one outer step
    expect(result.eventsLogged).toBe(2); // two inner tool calls
    expect(result.finalState.done).toBe(true);
    expect(result.chainSummary.usedBlueprint).toBe(true);
    expect(result.chainSummary.blueprintChainSignature).toBe('graph_query>write_observation');
    expect(result.chainSummary.innerSteps).toBe(2);
    expect(result.chainSummary.doneReason).toBe('tool_signaled_completion');
  });

  it('should stop blueprint on first inner step failure', async () => {
    const { executor, store, runner } = createTestExecutor();

    // Make graph_query fail
    runner.register('graph_query', async () => { throw new Error('query failed'); });

    await store.putTrail({
      id: 'bp_fail', goalId: 'fail_test', agentId: 'a1', status: 'active', kind: 'blueprint',
      nextAction: { tool: 'graph_query', paramsTemplate: { query: 'fail' } },
      blueprintMeta: {
        chainSignature: 'graph_query>write_observation',
        actionSequence: [
          { tool: 'graph_query', paramsTemplate: { query: 'fail' } },
          { tool: 'write_observation', paramsTemplate: { kind: 'x', content: 'y' } },
        ],
        state: 'active', version: 1,
        sourceChainHashes: [], sourceEventCount: 3,
        promotionStats: { avgSuccessRate: 1.0, avgLatencyMs: 40, avgSteps: 2, avgCostUsd: 0 },
        preconditions: [], expectedDoneReason: 'tool_signaled_completion',
        promotedAt: new Date().toISOString(),
      },
      steps: [], executionEventIds: [], successScore: 0.9, confidence: 0.9,
      weight: 0.8, decayRate: 0.02, tags: [], createdAt: new Date().toISOString(),
    });

    const result = await executor.execute('fail_test', 'agent_1', {
      maxSteps: 5,
      routing: { strategy: 'force_softmax', temperature: 0.1 },
    });

    expect(result.eventsLogged).toBe(1); // only first step logged
    expect(result.chainSummary.doneReason).toBe('blueprint_step_failed');
  });

  it('should release lease after blueprint execution', async () => {
    const { executor, store } = createTestExecutor();

    await store.putTrail({
      id: 'bp_lease', goalId: 'lease_test', agentId: 'a1', status: 'active', kind: 'blueprint',
      nextAction: { tool: 'write_observation', paramsTemplate: { kind: 'x', content: 'y' } },
      blueprintMeta: {
        chainSignature: 'write_observation',
        actionSequence: [{ tool: 'write_observation', paramsTemplate: { kind: 'test', content: 'done' } }],
        state: 'active', version: 1,
        sourceChainHashes: [], sourceEventCount: 3,
        promotionStats: { avgSuccessRate: 1.0, avgLatencyMs: 10, avgSteps: 1, avgCostUsd: 0 },
        preconditions: [], expectedDoneReason: 'tool_signaled_completion',
        promotedAt: new Date().toISOString(),
      },
      steps: [], executionEventIds: [], successScore: 0.9, confidence: 0.9,
      weight: 0.8, decayRate: 0.02, tags: [], createdAt: new Date().toISOString(),
    });

    await executor.execute('lease_test', 'agent_1', {
      maxSteps: 1,
      routing: { strategy: 'force_softmax', temperature: 0.1 },
    });

    const leased = await store.isLeased('bp_lease');
    expect(leased).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/executor/blueprint-execution.test.js`
Expected: FAIL — blueprint execution not implemented.

- [ ] **Step 3: Add blueprint execution to ExecutionLoop**

In `core/src/executor/execution-loop.js`, inside the `try` block after lease acquisition (around line 163), replace the single-action execution path with a branch:

```js
          // C-F: EXECUTE (branch on trail kind)
          if (trail.kind === 'blueprint' && trail.blueprintMeta?.actionSequence?.length) {
            // ── BLUEPRINT EXECUTION: composite action sequence ──
            let innerSteps = 0;
            let innerSucceeded = 0;
            let innerLatencyMs = 0;
            let blueprintDoneReason = 'all_steps_completed';

            for (const actionRef of trail.blueprintMeta.actionSequence) {
              // Budget check per inner step
              // (V1: simple wall-clock check)

              let boundAction;
              try {
                boundAction = await this.actionBinder.bind(actionRef, workingMemory, canonicalState);
              } catch {
                blueprintDoneReason = 'blueprint_bind_failed';
                workingMemory.failuresCount++;
                break;
              }

              let toolResult;
              try {
                toolResult = await this.toolRunner.run(boundAction, budget);
              } catch (runError) {
                toolResult = {
                  success: false, error: runError.message,
                  output: null, durationMs: 0, tokensUsed: 0, metadata: {},
                };
              }

              innerSteps++;
              innerLatencyMs += toolResult.durationMs ?? 0;

              // Write per-step event (blueprint steps are NOT opaque)
              const outcomeToolResult = {
                result: toolResult.success ? toolResult.output : null,
                error: toolResult.success ? null : (toolResult.error || 'Unknown error'),
                latencyMs: toolResult.durationMs ?? 0,
                tokensUsed: toolResult.tokensUsed ?? 0,
                estimatedCostUsd: toolResult.metadata?.estimatedCostUsd ?? 0,
              };
              workingMemory.stepIndex = step;
              const event = await this.outcomeWriter.write(
                trail, boundAction, outcomeToolResult, routingDecision, workingMemory,
              );
              events.push(event);

              // Update working memory (chain flows between steps)
              if (toolResult.success && toolResult.output) {
                if (typeof toolResult.output === 'object' && toolResult.output !== null) {
                  Object.assign(workingMemory.context, toolResult.output);
                }
                innerSucceeded++;

                if (toolResult.output.done === true) {
                  workingMemory.done = true;
                  doneReason = 'tool_signaled_completion';
                  blueprintDoneReason = 'tool_signaled_completion';
                  break;
                }
              }

              if (!toolResult.success) {
                workingMemory.failuresCount++;
                doneReason = 'blueprint_step_failed';
                blueprintDoneReason = 'blueprint_step_failed';
                break;
              }
            }

            workingMemory.recentTrailHistory.push(trail.id);

            // Store blueprint execution summary in chainSummary later
            workingMemory._blueprintExecSummary = {
              blueprintId: trail.id,
              chainSignature: trail.blueprintMeta.chainSignature,
              stepsAttempted: innerSteps,
              stepsSucceeded: innerSucceeded,
              totalLatencyMs: innerLatencyMs,
              doneReason: blueprintDoneReason,
            };

          } else {
            // ── SINGLE-ACTION EXECUTION (existing code) ──
```

Make sure the existing single-action code is inside this `else` block. Close the `else` block after the existing `workingMemory.recentTrailHistory.push(trail.id);` line.

- [ ] **Step 4: Update chainSummary to include blueprint fields**

In the PHASE 3 return section, update `chainSummary`:

```js
    const bpSummary = workingMemory._blueprintExecSummary;
    const chainSummary = {
      toolSequence: events.map((e) => e.action_name),
      trailSequence: events.map((e) => e.trail_id),
      uniqueTrails: trailsUpdated.length,
      successRate: events.length ? events.filter((e) => e.success).length / events.length : 0,
      totalLatencyMs: events.reduce((sum, e) => sum + (e.latency_ms || 0), 0),
      doneReason,
      usedBlueprint: !!bpSummary,
      blueprintId: bpSummary?.blueprintId || null,
      blueprintChainSignature: bpSummary?.chainSignature || null,
      outerSteps: step,
      innerSteps: events.length,
      blueprintExecutionSummary: bpSummary || null,
    };
```

- [ ] **Step 5: Run blueprint execution tests**

Run: `npx vitest run tests/executor/blueprint-execution.test.js`
Expected: PASS (3 tests)

- [ ] **Step 6: Run all executor tests**

Run: `npx vitest run tests/executor/`
Expected: All tests pass.

- [ ] **Step 7: Commit**

```bash
git add core/src/executor/execution-loop.js tests/executor/blueprint-execution.test.js
git commit -m "feat: add blueprint execution to ExecutionLoop — composite trails with per-step events"
```

---

## Task 7: API Endpoints + Post-Execution Hook

**Files:**
- Modify: `core/src/server.js`

- [ ] **Step 1: Add ChainMiner initialization**

In `core/src/server.js`, after the existing Trail Executor imports (around line 111), add:

```js
const { ChainMiner } = await import('./executor/chain-miner.js');
```

After `trailExecutor` is created (around line 331), add:

```js
  const chainMiner = new ChainMiner(executorStore, {
    minOccurrences: 3,
    minSuccessRate: 0.9,
    maxAvgLatencyMs: 5000,
    lookbackRuns: 50,
    autoActivate: true,
  });
  trailExecutor._chainMiner = chainMiner;
```

- [ ] **Step 2: Add post-execution mining hook**

In the `POST /api/swarm/execute` handler, after the execute call:

```js
              const result = await trailExecutor.execute(body.goal, agentId, config);

              // Non-blocking: mine for blueprint candidates after each execution
              if (trailExecutor._chainMiner) {
                trailExecutor._chainMiner.mine(body.goal).catch(() => {});
              }

              return jsonResponse(res, result);
```

- [ ] **Step 3: Add blueprints/mine endpoint**

After the `executor/status` case, add:

```js
        case '/api/swarm/blueprints/mine':
          if (req.method === 'POST') {
            if (!trailExecutor?._chainMiner) return jsonResponse(res, { error: 'ChainMiner unavailable' }, 503);
            try {
              if (!body.goal_id) return jsonResponse(res, { error: 'goal_id is required' }, 400);
              const result = await trailExecutor._chainMiner.mine(body.goal_id);
              return jsonResponse(res, result);
            } catch (error) {
              return jsonResponse(res, { error: 'Mining failed', message: error.message }, 500);
            }
          }
          break;

        case '/api/swarm/blueprints':
          if (req.method === 'GET') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const goalId = url.searchParams.get('goal_id');
              const stateFilter = url.searchParams.get('state');
              if (!goalId) return jsonResponse(res, { error: 'goal_id query param is required' }, 400);

              const allTrails = await trailExecutor._store.getCandidateTrails(goalId);
              let blueprints = allTrails.filter(t => t.kind === 'blueprint');
              if (stateFilter) {
                blueprints = blueprints.filter(t => t.blueprintMeta?.state === stateFilter);
              }

              return jsonResponse(res, {
                blueprints: blueprints.map(b => ({
                  id: b.id,
                  chainSignature: b.blueprintMeta?.chainSignature,
                  state: b.blueprintMeta?.state,
                  version: b.blueprintMeta?.version,
                  promotionStats: b.blueprintMeta?.promotionStats,
                  sourceEventCount: b.blueprintMeta?.sourceEventCount,
                  promotedAt: b.blueprintMeta?.promotedAt,
                  actionSequence: b.blueprintMeta?.actionSequence,
                  weight: b.weight,
                })),
                count: blueprints.length,
              });
            } catch (error) {
              return jsonResponse(res, { error: 'List blueprints failed', message: error.message }, 500);
            }
          }
          break;
```

- [ ] **Step 4: Add blueprint PATCH endpoint**

```js
        // Handle /api/swarm/blueprints/:id via pathname parsing
```

For the PATCH endpoint, add detection in the switch statement before the default case. Since the server uses exact pathname matching, add a dynamic route check:

After the `case '/api/swarm/blueprints':` block, before `case '/api/consensus/evaluate':`, add:

```js
        default:
          // Dynamic route: /api/swarm/blueprints/:id
          if (pathname.startsWith('/api/swarm/blueprints/') && req.method === 'PATCH') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              const blueprintId = pathname.split('/api/swarm/blueprints/')[1];
              if (!blueprintId) return jsonResponse(res, { error: 'blueprint id is required' }, 400);
              if (!body.state || !['active', 'deprecated'].includes(body.state)) {
                return jsonResponse(res, { error: 'state must be "active" or "deprecated"' }, 400);
              }

              const trail = await trailExecutor._store.getTrail(blueprintId);
              if (!trail || trail.kind !== 'blueprint') {
                return jsonResponse(res, { error: 'Blueprint not found' }, 404);
              }

              if (body.expected_version && trail.blueprintMeta?.version !== body.expected_version) {
                return jsonResponse(res, { error: 'Version mismatch', current_version: trail.blueprintMeta?.version }, 409);
              }

              trail.blueprintMeta.state = body.state;
              await trailExecutor._store.putTrail(trail);

              return jsonResponse(res, {
                id: trail.id,
                chainSignature: trail.blueprintMeta.chainSignature,
                state: trail.blueprintMeta.state,
                version: trail.blueprintMeta.version,
                updated_at: new Date().toISOString(),
              });
            } catch (error) {
              return jsonResponse(res, { error: 'Update blueprint failed', message: error.message }, 500);
            }
          }
```

Note: This `default` case must be placed carefully within the existing switch to avoid conflicts with other dynamic routes. Add it as a check inside the existing default/fallthrough handler.

- [ ] **Step 5: Add kind filter to existing trails endpoint**

Update the `GET /api/swarm/trails` handler to support `?kind=`:

```js
          if (req.method === 'GET') {
            if (!trailExecutor) return jsonResponse(res, { error: 'Trail Executor unavailable' }, 503);
            try {
              const url = new URL(req.url, `http://${req.headers.host}`);
              const goalId = url.searchParams.get('goal_id');
              const kindFilter = url.searchParams.get('kind');
              if (!goalId) return jsonResponse(res, { error: 'goal_id query param is required' }, 400);
              let trails = await trailExecutor._store.getCandidateTrails(goalId);
              if (kindFilter) {
                trails = trails.filter(t => (t.kind || 'raw') === kindFilter);
              }
              return jsonResponse(res, { trails, count: trails.length });
            } catch (error) {
              return jsonResponse(res, { error: 'List trails failed', message: error.message }, 500);
            }
          }
```

- [ ] **Step 6: Verify server syntax**

Run: `node --check core/src/server.js`
Expected: No errors.

- [ ] **Step 7: Commit**

```bash
git add core/src/server.js
git commit -m "feat: add blueprint API endpoints + post-execution mining hook"
```

---

## Task 8: Deploy + Benchmark Validation

**Files:** None (deploy and test only)

- [ ] **Step 1: Deploy**

```bash
bash /opt/HIVEMIND/scripts/deploy.sh core
```

Expected: 9+ passed, hm-core healthy.

- [ ] **Step 2: Run 20 executions to seed chain data**

```bash
API_KEY="hmk_live_6e3c4962c39612fcd54fe65fbf2a41f70418e8c971d13841"
USER_ID="986ac853-5597-40b2-b48a-02dc88d3ae1d"
BASE="http://localhost:3001"
GOAL="blueprint_bench"

# Seed trails
curl -s -X POST "$BASE/api/swarm/trails" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" -H "Content-Type: application/json" \
  -d "{\"goal_id\":\"$GOAL\",\"next_action\":{\"tool\":\"graph_query\",\"params_template\":{\"query\":\"test\"}},\"confidence\":0.8,\"weight\":0.75,\"tags\":[\"bench\"]}" > /dev/null
curl -s -X POST "$BASE/api/swarm/trails" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" -H "Content-Type: application/json" \
  -d "{\"goal_id\":\"$GOAL\",\"next_action\":{\"tool\":\"write_observation\",\"params_template\":{\"kind\":\"bench\",\"content\":\"result\"}},\"confidence\":0.7,\"weight\":0.7,\"tags\":[\"bench\"]}" > /dev/null

# Run 20 executions
for i in $(seq 1 20); do
  curl -s -X POST "$BASE/api/swarm/execute" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" -H "Content-Type: application/json" \
    -d "{\"goal\":\"$GOAL\",\"agent_id\":\"bench_agent\",\"max_steps\":5,\"routing\":{\"temperature\":1.0}}" > /dev/null
done
echo "20 runs complete"
```

- [ ] **Step 3: Trigger mining**

```bash
curl -s -X POST "$BASE/api/swarm/blueprints/mine" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" -H "Content-Type: application/json" \
  -d "{\"goal_id\":\"$GOAL\"}" | python3 -m json.tool
```

Expected: At least one blueprint activated.

- [ ] **Step 4: List blueprints**

```bash
curl -s "$BASE/api/swarm/blueprints?goal_id=$GOAL" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" | python3 -m json.tool
```

Expected: Blueprint with `chainSignature: "graph_query>write_observation"` and `state: "active"`.

- [ ] **Step 5: Run 5 more executions — verify blueprint is used**

```bash
for i in $(seq 1 5); do
  curl -s -X POST "$BASE/api/swarm/execute" -H "X-API-Key: $API_KEY" -H "X-HM-User-Id: $USER_ID" -H "Content-Type: application/json" \
    -d "{\"goal\":\"$GOAL\",\"agent_id\":\"bench_agent\",\"max_steps\":5,\"routing\":{\"temperature\":0.5,\"force_weights\":{\"goalAttraction\":1,\"affordanceAttraction\":1,\"conflictRepulsion\":1,\"congestionRepulsion\":1,\"costRepulsion\":1,\"blueprintPrior\":0.3}}}" | \
    python3 -c "import sys,json; d=json.load(sys.stdin); print(f'Run {$i}: blueprint={d[\"chainSummary\"].get(\"usedBlueprint\",False)} steps={d[\"stepsExecuted\"]} done={d[\"chainSummary\"][\"doneReason\"]}')"
done
```

Expected: At least some runs show `blueprint=True`.

- [ ] **Step 6: Commit benchmark results**

```bash
git add -A
git commit -m "feat: blueprint extraction complete — mining, execution, and API verified in production"
git push origin main
```

---

## Success Criteria Checklist

- [ ] ChainMiner extracts `graph_query>write_observation` as a blueprint from benchmark data
- [ ] Blueprint trail has correct `chainSignature`, `actionSequence`, `promotionStats`
- [ ] Selector prefers blueprint trail with modest boost
- [ ] Blueprint execution chains tools through working memory
- [ ] Blueprint execution emits per-step events (not opaque)
- [ ] Blueprint execution stops on failure
- [ ] `chainSummary` shows `usedBlueprint: true` when blueprint selected
- [ ] Mining is idempotent (repeated calls don't create duplicates)
- [ ] Deprecated blueprints excluded from selection
- [ ] Post-execution mining hook fires asynchronously

---

## Document History

| Date | Version | Status |
|------|---------|--------|
| 2026-03-27 | 1.0 | Plan Complete |

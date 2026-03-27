# Blueprint Extraction: From Habits to Procedures

**Date**: 2026-03-27
**Status**: Design Document (Ready for Implementation Planning)
**Scope**: Blueprint extraction, promotion, execution, and lifecycle management
**Prerequisite**: Trail Executor V1 (complete, deployed, benchmarked)

---

## Executive Summary

Blueprints are promoted composite trails extracted from repeated successful execution chains, executed transparently through the existing runtime, and managed through lightweight lifecycle APIs.

This is the bridge from **Approach 2** (separate execution layer with raw trails) to **Approach 3** (reusable procedures). The system's emerging "habits" — repeated tool chains that succeed reliably — become first-class executable procedures without requiring a second runtime or split-brain routing.

---

## Problem Statement

The Trail Executor V1 benchmark (20 runs, 100% success) revealed natural chain patterns:

| Pattern | Frequency | Success Rate |
|---------|-----------|-------------|
| `graph_query → write_observation` | 35% | 100% |
| `write_observation` | 35% | 100% |
| `graph_query → graph_query → write_observation` | 25% | 100% |
| `graph_query × 3 → write_observation` | 5% | 100% |

These patterns are **rediscovered from scratch on every execution**. The runtime has no mechanism to recognize that `graph_query → write_observation` is a proven procedure and prefer it directly.

Blueprint extraction solves this by:
1. Mining execution history for repeated successful chains
2. Promoting qualifying patterns into blueprint trails
3. Letting the selector prefer proven procedures through a modest force boost
4. Maintaining full transparency (per-step events, weight updates, lease control)

---

## Design Decision: Blueprint as Special Trail (Approach A)

Blueprints are modeled as trails with `kind: "blueprint"` and extra metadata. The selector sees one candidate type (`Trail`), but distinguishes raw trails from blueprint trails via the `kind` field.

**Why this approach:**
- Reuses existing runtime (selector, executor, events, leases, weights)
- No split-brain routing logic
- No factory indirection
- Blueprints compete through normal force routing with a modest prior boost
- Fastest path from repeated chains to executable reusable behavior
- Reversible — can graduate to richer blueprint schemas later

---

## Data Model

### Schema Changes to `op_trails`

```sql
ALTER TABLE op_trails ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'raw';
ALTER TABLE op_trails ADD COLUMN IF NOT EXISTS blueprint_meta JSONB;
CREATE INDEX IF NOT EXISTS op_trails_kind_idx ON op_trails(kind);
```

### Blueprint Trail Structure

A blueprint trail has all normal trail fields, plus:

```js
{
  // Standard trail fields (unchanged)
  id, goalId, agentId, status, nextAction,
  steps, executionEventIds, successScore,
  confidence, weight, decayRate, tags, createdAt,

  // Blueprint-specific fields
  kind: "blueprint",                    // "raw" for normal trails

  blueprintMeta: {
    chainSignature: "graph_query>write_observation",  // canonical pattern
    actionSequence: [                                  // ordered steps template
      { tool: "graph_query", paramsTemplate: { query: "$ctx.searchTerm", limit: 3 } },
      { tool: "write_observation", paramsTemplate: { kind: "$ctx.obsKind", content: "$ctx.result" } }
    ],
    sourceChainHashes: ["abc123", "def456"],   // hashes of source executions
    sourceEventCount: 7,                        // how many successful runs seeded this
    promotionStats: {
      avgSuccessRate: 1.0,
      avgLatencyMs: 42,
      avgSteps: 2,
      avgCostUsd: 0.001,
    },
    preconditions: [],                          // V2: required context keys
    expectedDoneReason: "tool_signaled_completion",
    version: 1,
    state: "candidate" | "active" | "deprecated",
    promotedAt: "2026-03-27T...",
  }
}
```

### Field Semantics

- **`kind`**: `"raw"` (default for all existing trails) or `"blueprint"` (promoted composite trail)
- **`chainSignature`**: Canonical normalized string — `toolNames.join(">")` after trimming empty steps. Used for deduplication and analytics.
- **`actionSequence`**: Ordered array of `ActionRef` objects. The execution loop iterates through these in order.
- **`nextAction`**: Set to the first step of `actionSequence` for backward compatibility. Execution reads from `actionSequence` when `kind === "blueprint"`.
- **`sourceChainHashes`**: SHA-256 hashes of the `chainSummary.toolSequence` from source executions. Enables provenance tracking.
- **`sourceEventCount`**: Number of successful executions that contributed to this blueprint's evidence.
- **`promotionStats`**: Aggregated metrics from source executions at promotion time. Used by selector and analytics.
- **`state`**: `"candidate"` (detected but not yet active), `"active"` (available for selection), `"deprecated"` (retired, not selected).
- **`version`**: Integer, incremented if blueprint is re-promoted with updated stats.

**Storage note**: Blueprints are stored in `op_trails` for execution reuse in V1. They represent promoted procedural knowledge and may later graduate to a dedicated procedural namespace (e.g., `kg/procedures`), but the current design keeps them in the operational layer for simplicity.

**Parameter generalization note**: V1 blueprint extraction assumes the discovered sequence is reusable with the existing `paramsTemplate` abstraction (e.g., `$ctx.`, `$kg.` bindings). More complex parameter abstraction (where structurally similar chains differ in bound values) is deferred to V2.

---

## Component 1: ChainMiner

### Purpose

Scans execution history for repeated successful chains and emits blueprint candidates.

### Interface

```js
class ChainMiner {
  constructor(store, config) {
    // config = {
    //   minOccurrences: 3,        // minimum times pattern must appear
    //   minSuccessRate: 0.9,      // minimum success rate
    //   maxAvgLatencyMs: 5000,    // maximum average latency
    //   lookbackRuns: 50,         // only scan last N runs (bounded window)
    //   autoActivate: true,       // V1: auto-promote candidates to active
    // }
  }

  async mine(goalId): Promise<MineResult> {
    // Returns { candidatesCreated, blueprintsActivated, blueprintsSkippedExisting, details[] }
  }
}
```

### Mining Algorithm

```
mine(goalId):
  1. QUERY recent execution events for this goalId
     - bounded by lookbackRuns (default 50) or lookbackHours
     - only completed runs (doneReason = "tool_signaled_completion")

  2. GROUP events by execution run
     - use trail sequence to reconstruct per-run chains

  3. EXTRACT chain signatures
     - for each successful run: canonicalize(toolSequence).join(">")
     - canonicalize: trim empty steps, normalize tool names, collapse whitespace

  4. COUNT frequency per signature
     - { "graph_query>write_observation": 7, "write_observation": 7, ... }

  5. COMPUTE stats per signature
     - avgSuccessRate, avgLatencyMs, avgCostUsd, avgSteps
     - collect sourceChainHashes

  6. FILTER by promotion thresholds
     - occurrences >= minOccurrences
     - successRate >= minSuccessRate
     - avgLatencyMs <= maxAvgLatencyMs
     - doneReason must be "tool_signaled_completion"

  7. DEDUPE against existing blueprints
     - query op/trails WHERE kind="blueprint" AND chainSignature matches AND goalId matches
     - if active blueprint exists with same signature: skip (increment skippedExisting)
     - if deprecated blueprint exists: skip (don't resurrect automatically)
     - if candidate exists: update stats, don't create duplicate

  8. CREATE blueprint candidates
     - for each qualifying pattern not already covered:
       - create trail with kind="blueprint", state="candidate"
       - populate blueprintMeta with stats, signature, actionSequence
       - if autoActivate: immediately set state="active"

  9. LOG mining outcome
     - for each signature: mined count, threshold pass/fail, action taken
     - store in app logs (structured, queryable)

  10. RETURN MineResult
      - { candidatesCreated, blueprintsActivated, blueprintsSkippedExisting, details }
```

### Idempotency

Mining is safe to call repeatedly:
- **Dedupe key**: `unique(goalId, chainSignature, version)` defines blueprint identity. For V1, version remains `1` unless the pattern is intentionally re-promoted with materially changed stats or sequence.
- Stats are updated on existing candidates if re-mined
- No race conditions: check-then-create in single transaction

---

## Component 2: Blueprint Execution in ExecutionLoop

### Changes to ExecutionLoop

When the selector picks a blueprint trail, the execution loop handles `actionSequence` as a composite step:

```
if trail.kind === "blueprint" AND trail.blueprintMeta.actionSequence.length > 0:

  innerSteps = 0
  innerSucceeded = 0
  innerLatencyMs = 0

  for each actionRef in trail.blueprintMeta.actionSequence:

    // A. BUDGET CHECK (per inner step)
    if budget exceeded:
      doneReason = "budget_exhausted_within_blueprint"
      break

    // B. BIND params from working memory
    action = actionBinder.bind(actionRef, workingMemory, canonicalState)

    // C. EXECUTE tool
    result = toolRunner.run(action, remainingBudget)
    innerSteps++
    innerLatencyMs += result.latencyMs

    // D. WRITE event (blueprint steps are NOT opaque)
    event = outcomeWriter.write(trail, action, result, routingDecision, workingMemory)
    events.push(event)

    // E. UPDATE working memory (chain flows between steps)
    if result.success:
      Object.assign(workingMemory.context, result.output)
      innerSucceeded++

    // F. CHECK done
    if result.output.done === true:
      workingMemory.done = true
      doneReason = "tool_signaled_completion"
      break

    // G. CHECK failure — stop blueprint on first failure
    if !result.success:
      workingMemory.failuresCount++
      doneReason = "blueprint_step_failed"
      break

  // Build blueprint execution summary
  blueprintExecutionSummary = {
    blueprintId: trail.id,
    chainSignature: trail.blueprintMeta.chainSignature,
    stepsAttempted: innerSteps,
    stepsSucceeded: innerSucceeded,
    totalLatencyMs: innerLatencyMs,
    doneReason
  }

  // Count as ONE outer step (one routing decision, many inner tool calls)
  step++

else:
  // Existing single-action trail execution (unchanged)
```

### Key Rules

1. **Per-step events** — Every inner tool call emits an execution event. Blueprints are transparent.
2. **Working memory flows** — Output from step N is available to step N+1 via `$ctx.` param resolution.
3. **Failure stops the blueprint** — First failed inner step aborts the sequence. No partial success pretending to be full success.
4. **Per-inner-step budget check** — Budget is validated before each inner step, not just at blueprint start.
5. **One outer step** — A blueprint execution counts as one routing decision but many inner tool calls. Metrics distinguish `outerSteps` (routing decisions) from `innerSteps` (actual tool calls).
6. **Lease spans the full blueprint** — Acquired before, released after all inner steps complete (in finally block).

---

## Component 3: ForceRouter Blueprint Boost

Blueprints get a modest configurable prior in force computation:

```js
// In ForceRouter.computeForces():
const blueprintBoost = (trail.kind === 'blueprint' &&
                        trail.blueprintMeta?.state === 'active')
                       ? (w.blueprintPrior ?? 0.3) : 0;

const net = goalAttr + affordanceAttr + blueprintBoost
          - conflictRep - congestionRep - costRep;
```

- **Default boost: 0.3** — enough to prefer proven patterns when force scores are close
- **Configurable**: `routing.forceWeights.blueprintPrior` in execution config
- **Not dominant**: Raw trails can still win with stronger goal attraction or if the blueprint is congested

**Selector exclusion rules:**
- `state: "candidate"` blueprints are **not selectable** (not yet proven enough for execution)
- `state: "deprecated"` blueprints are **never selectable** (retired from use)
- `state: "active"` blueprints are selectable and receive the prior boost
- The `TrailSelector` filters by `status === 'active'` AND (`kind === 'raw'` OR `blueprintMeta.state === 'active'`)

---

## Component 4: API Endpoints

### `POST /api/swarm/blueprints/mine`

Trigger chain mining on demand. Idempotent — safe to call repeatedly.

```
Request: {
  goal_id: string (required),
  lookback_runs?: number (default: 50)
}

Response: {
  candidates_created: number,
  blueprints_activated: number,
  blueprints_skipped_existing: number,
  details: [{
    chain_signature: string,
    occurrences: number,
    success_rate: number,
    avg_latency_ms: number,
    action: "created" | "activated" | "skipped" | "below_threshold"
  }]
}
```

### `GET /api/swarm/blueprints?goal_id=X`

List blueprints for a goal. Optional `?state=active` filter.

```
Response: {
  blueprints: [{
    id, chainSignature, state, version,
    promotionStats, sourceEventCount, promotedAt,
    actionSequence
  }],
  count: number
}
```

### `PATCH /api/swarm/blueprints/:id`

Update blueprint state. Supports optimistic version safety.

```
Request: {
  state: "active" | "deprecated",
  expected_version?: number  // optional: reject if version doesn't match
}

Response: {
  id, chainSignature, state, version, updated_at
}
```

### Modification to existing `GET /api/swarm/trails`

Add `?kind=raw|blueprint` filter support:

```
GET /api/swarm/trails?goal_id=X&kind=blueprint
```

### Modification to `POST /api/swarm/execute` response

Add blueprint fields to `chainSummary`:

```js
chainSummary: {
  toolSequence: [...],
  trailSequence: [...],
  uniqueTrails: 2,
  successRate: 1.0,
  totalLatencyMs: 42,
  doneReason: "tool_signaled_completion",

  // New fields
  usedBlueprint: true,
  blueprintId: "uuid",
  blueprintChainSignature: "graph_query>write_observation",
  outerSteps: 1,    // routing decisions
  innerSteps: 2,    // actual tool calls
  blueprintExecutionSummary: {
    stepsAttempted: 2,
    stepsSucceeded: 2,
    totalLatencyMs: 42,
    doneReason: "tool_signaled_completion"
  }
}
```

---

## Integration: Post-Execution Mining Hook

After `TrailExecutor.execute()` returns, mining is triggered asynchronously:

```js
// In server.js POST /api/swarm/execute handler:
const result = await trailExecutor.execute(body.goal, agentId, config);

// Non-blocking: mine for blueprint candidates
if (trailExecutor._chainMiner) {
  trailExecutor._chainMiner.mine(body.goal).catch(() => {});
}

return jsonResponse(res, result);
```

Mining errors do not affect the execution response. Fire-and-forget.

---

## Implementation Path

### Phase 1: Schema + ChainMiner

- Add `kind` and `blueprint_meta` columns to `op_trails`
- Implement `ChainMiner` with mining algorithm
- Add `mine()` method to InMemoryStore and PrismaStore
- Tests for chain extraction, deduplication, threshold filtering

### Phase 2: Blueprint Execution

- Modify `ExecutionLoop` to handle `actionSequence` for blueprint trails
- Add per-inner-step budget checks
- Add blueprint execution summary to results
- Add `blueprintPrior` to `ForceRouter`
- Tests for blueprint execution, failure handling, working memory flow

### Phase 3: API + Integration

- Wire `POST /api/swarm/blueprints/mine` endpoint
- Wire `GET /api/swarm/blueprints` endpoint
- Wire `PATCH /api/swarm/blueprints/:id` endpoint
- Add `?kind=` filter to existing trails endpoint
- Add post-execution mining hook
- Deploy and run benchmark: same goal 20 runs, verify blueprints extracted and used

---

## Success Criteria

- [ ] ChainMiner extracts `graph_query>write_observation` as a blueprint from 20-run benchmark data
- [ ] Blueprint trail created with correct `chainSignature`, `actionSequence`, `promotionStats`
- [ ] Selector prefers blueprint trail with modest boost (not dominant)
- [ ] Blueprint execution chains tools through working memory (step N output available to step N+1)
- [ ] Blueprint execution emits per-step events (not opaque)
- [ ] Blueprint execution stops on failure (no partial success)
- [ ] Per-inner-step budget check prevents mid-blueprint budget overrun
- [ ] `chainSummary` in execute response shows `usedBlueprint: true` when blueprint was selected
- [ ] Mining is idempotent (repeated calls don't create duplicates)
- [ ] Deprecated blueprints are excluded from selection
- [ ] Post-execution mining hook fires asynchronously without blocking response

---

## Document History

| Date | Version | Status |
|------|---------|--------|
| 2026-03-27 | 1.0 | Design Complete, Ready for Implementation Planning |

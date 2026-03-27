# Gap D: Dashboard + MetaEvaluator + Parameter Registry

**Date**: 2026-03-27
**Status**: Design Document (Ready for Implementation Planning)
**Scope**: Controlled meta-loop — observation, evaluation, and safe parameter tuning
**Prerequisite**: Trail Executor V1 + Blueprint Extraction + Agent Identity (all complete)

---

## Executive Summary

Gap D introduces a controlled meta-loop where the system observes runtime behavior through dashboard APIs, evaluates performance through explicit batch analysis, and adjusts operating policy through an auditable parameter registry.

This is **not** autonomous self-evolution. It is a disciplined feedback loop:

1. **Dashboard** makes the system legible (read-only observation)
2. **MetaEvaluator** makes it understandable (batch analysis with recommendations)
3. **Parameter Registry** makes it safely tunable (auditable config changes with rollback)

The key design principle: **policy evolution through configuration, not code mutation.**

---

## Component 1: Dashboard API

Read-only endpoints that query existing `op/*` and `meta/*` tables directly. No materialization pipeline. Stable API contracts that don't expose raw table structure.

### Common Filters

All dashboard endpoints support:
- `?window=24h|7d|30d|all` — time window filter (default: `7d`)
- Additional endpoint-specific filters as documented below

### Endpoints

#### `GET /api/swarm/dashboard/overview`

System-level summary. All metrics are averages/aggregates over the selected time window.

```json
{
  "window": "7d",
  "executions": {
    "total": 45,
    "successRate": 0.89,
    "avgLatencyMs": 38,
    "doneReasons": {
      "tool_signaled_completion": 40,
      "budget_exhausted": 3,
      "blueprint_step_failed": 2
    }
  },
  "blueprints": {
    "active": 2,
    "candidates": 0,
    "deprecated": 0,
    "usageRate": 0.35,
    "rawVsBlueprintSelectionRate": { "raw": 0.65, "blueprint": 0.35 },
    "avgBlueprintSuccessRate": 1.0
  },
  "agents": {
    "total": 3,
    "active": 3,
    "avgSuccessRate": 0.84,
    "topAgent": { "agent_id": "explorer_1", "success_rate": 0.92 }
  },
  "routing": {
    "avgTemperature": 0.8,
    "forceContributions": {
      "goalAttraction": 0.42,
      "affordanceAttraction": 0.28,
      "blueprintBoost": 0.08,
      "socialAttraction": 0.04,
      "momentum": 0.03,
      "conflictRepulsion": 0.15,
      "congestionRepulsion": 0.05,
      "costRepulsion": 0.05
    },
    "note": "Force contributions and avgTemperature are computed from the effective routing config used in actual executions (including per-request overrides), not just registry defaults"
  }
}
```

**Success rate definition** (consistent across all endpoints): `successRate = executions where doneReason === 'tool_signaled_completion' / total executions`

#### `GET /api/swarm/dashboard/executions`

Recent execution history. Filters: `?limit=50&agent_id=X&goal=Y&window=7d`

```json
{
  "executions": [{
    "goal": "...",
    "agentId": "...",
    "stepsExecuted": 2,
    "eventsLogged": 2,
    "doneReason": "tool_signaled_completion",
    "usedBlueprint": true,
    "blueprintSignature": "graph_query>write_observation",
    "totalLatencyMs": 42,
    "successRate": 1.0,
    "toolSequence": ["graph_query", "write_observation"],
    "timestamp": "..."
  }],
  "count": 50
}
```

#### `GET /api/swarm/dashboard/blueprints`

Blueprint performance comparison. Filter: `?window=7d`

```json
{
  "blueprints": [{
    "chainSignature": "graph_query>write_observation",
    "state": "active",
    "totalExecutions": 15,
    "successRate": 1.0,
    "avgLatencyMs": 42,
    "vsRawTrailAvgLatencyMs": 68,
    "winRate": 0.62
  }]
}
```

**`winRate` definition**: percentage of eligible executions where the blueprint was selected and completed successfully. An execution is "eligible" if the blueprint was `active` and matched the goal context at selection time, while at least one comparable raw trail was also selectable.

#### `GET /api/swarm/dashboard/agents`

Agent performance comparison. Filter: `?window=7d`

```json
{
  "agents": [{
    "agent_id": "explorer_1",
    "role": "explorer",
    "source": "explicit",
    "status": "active",
    "successRate": 0.92,
    "totalExecutions": 25,
    "topSkills": [{ "tool": "graph_query", "success_rate": 0.95 }],
    "specialization": { "explorer": 0.72, "operator": 0.58 },
    "blueprintUsageRate": 0.4
  }]
}
```

### Implementation Notes

- All queries go directly to Prisma (no materialized views)
- Use existing indexes on `created_at`, `agent_id`, `trail_id`
- Time window filtering via `WHERE created_at >= now() - interval`
- Force contributions computed by averaging `routing.forceVector` from recent `op_execution_events`

---

## Component 2: MetaEvaluator

A batch analysis service that reads runtime data, detects issues, and produces actionable recommendations. **Recommends only — never auto-applies.**

### Interface

```js
class MetaEvaluator {
  constructor(store, parameterRegistry) {}

  async evaluate(options) → EvaluationReport
  // options = { lookbackRuns?: number, goalFilter?: string, agentFilter?: string }
  // Note: lookbackRuns is the primary bound on evaluation cost. Keep capped in V1
  // to prevent expensive scans as execution history grows.
}
```

### EvaluationReport

```json
{
  "evaluatedAt": "2026-03-27T...",
  "window": { "runs": 50, "goalFilter": null, "agentFilter": null },
  "summary": {
    "totalRuns": 50,
    "overallSuccessRate": 0.88,
    "blueprintUsageRate": 0.35,
    "routeDiversity": 0.45,
    "avgLatencyMs": 42,
    "avgCostUsd": 0.002
  },
  "systemStable": false,
  "issues": [
    {
      "type": "blueprint_underperforming",
      "severity": "warning",
      "actionable": true,
      "description": "Blueprint 'graph_query>write_observation' success rate (0.7) below raw trail average (0.9) for same goal family",
      "evidence": {
        "blueprintSuccess": 0.7,
        "rawSuccess": 0.9,
        "blueprintSampleSize": 15,
        "rawSampleSize": 20,
        "comparisonBaseline": "same goal family, same time window"
      },
      "recommendation": {
        "action": "deprecate_blueprint",
        "target": "bp_id_123",
        "confidence": "high"
      }
    }
  ],
  "parameterRecommendations": [
    {
      "param": "routing.forceWeights.blueprintPrior",
      "currentValue": 0.3,
      "recommendedValue": 0.2,
      "reason": "Blueprint win rate declining, reduce prior to allow more exploration",
      "confidence": "medium",
      "evidenceSampleSize": 30,
      "expectedTradeoff": "More exploration, slightly higher latency variance"
    }
  ],
  "agentInsights": [
    {
      "agent_id": "explorer_1",
      "insight": "Strong explorer profile (diverse tools, low blueprint reliance)",
      "recommendedRole": "explorer",
      "currentRole": "explorer",
      "roleMatch": true
    }
  ]
}
```

When no issues are detected: `systemStable: true`, empty `issues` and `parameterRecommendations` arrays.

### Detection Rules (V1 — Hardcoded)

| Rule | Trigger | Min Sample | Severity | Recommendation |
|------|---------|-----------|----------|---------------|
| Blueprint underperforming | Blueprint success < raw success for same goal family | 10 bp + 10 raw | warning | Deprecate or reduce blueprintPrior |
| Exploration too low | Route diversity < 0.3 | 20 selections | info | Increase temperature |
| Exploration too high | Route diversity > 0.9 with success < 0.7 | 20 selections | warning | Decrease temperature |
| Agent role mismatch | Specialization diverges from assigned role by > 0.3 | 10 executions | info | Suggest role update |
| Cost trending up | Avg cost per run increasing > 20% vs previous window | 20 runs | warning | Increase costRepulsion |
| High failure rate | Overall success < 0.7 | 10 runs | alert | Flag for review |
| Blueprint stagnation | Active blueprint never selected in > 20 eligible runs | 20 runs | info | Deprecate stale blueprint |
| Social convergence | One agent's trails dominate > 60% of selections | 20 selections | warning | Reduce social weight |

### Confidence Bands

- **low**: sample size < 2× minimum threshold, or trend is unstable
- **medium**: sample size meets threshold, trend is consistent over window
- **high**: sample size > 3× threshold, trend repeated across multiple windows

### Alert vs Actionable

- `actionable: true` — has a direct parameter recommendation
- `actionable: false` — informational alert, requires human judgment (e.g., "high failure rate" may have external causes)

### API

**`POST /api/swarm/meta/evaluate`**

```
Request: {
  lookback_runs?: number (default: 50),
  goal_filter?: string,
  agent_filter?: string,
}

Response: EvaluationReport
```

### Evaluation Logging

Each evaluation run is stored as an observation (kind: `meta_evaluation`) in `op_observations`:

```json
{
  "kind": "meta_evaluation",
  "content": {
    "window": { "runs": 50 },
    "issuesFound": 2,
    "recommendationsProduced": 1,
    "systemStable": false
  },
  "certainty": 0.8
}
```

This enables tracking evaluator behavior over time without a new table.

---

## Component 3: Parameter Registry

Centralized configuration store. The runtime reads current config from here. MetaEvaluator recommends changes. Humans apply them through an explicit endpoint.

### Schema

```sql
CREATE TABLE IF NOT EXISTS meta_parameters (
  key TEXT NOT NULL PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_by TEXT NOT NULL DEFAULT 'system',
  previous_value JSONB
);
```

Dedicated table — not repurposed from any existing table.

### Managed Parameters

```js
// Routing
"routing.temperature": 1.0,
"routing.forceWeights.goalAttraction": 1.0,
"routing.forceWeights.affordanceAttraction": 1.0,
"routing.forceWeights.blueprintPrior": 0.3,
"routing.forceWeights.social": 0.2,
"routing.forceWeights.momentum": 0.15,
"routing.forceWeights.conflictRepulsion": 1.0,
"routing.forceWeights.congestionRepulsion": 1.0,
"routing.forceWeights.costRepulsion": 1.0,

// Blueprint mining
"blueprint.minOccurrences": 3,
"blueprint.minSuccessRate": 0.9,
"blueprint.maxAvgLatencyMs": 5000,
"blueprint.lookbackRuns": 50,
"blueprint.autoActivate": true,

// Reputation
"reputation.emaAlpha": 0.1,
"reputation.minEvidence": 10,
"reputation.maxConfidenceWithoutEvidence": 0.6,

// Execution defaults
"execution.defaultMaxSteps": 10,
"execution.defaultBudgetMaxTokens": 50000,
"execution.defaultPromotionThreshold": 0.8,
```

### Validation Rules

Every parameter has a schema definition:

```js
const PARAMETER_SCHEMA = {
  "routing.temperature": { type: "number", min: 0.01, max: 10.0 },
  "routing.forceWeights.goalAttraction": { type: "number", min: 0, max: 5.0 },
  "routing.forceWeights.blueprintPrior": { type: "number", min: 0, max: 2.0 },
  "blueprint.minOccurrences": { type: "number", min: 1, max: 100 },
  "blueprint.minSuccessRate": { type: "number", min: 0, max: 1 },
  "reputation.emaAlpha": { type: "number", min: 0.001, max: 1 },
  // ... etc
};
```

`set()` and `applyRecommendations()` validate against this schema. Invalid values are rejected.

### Interface

```js
class ParameterRegistry {
  constructor(store) {}

  async get(key) → value | defaultValue
  async getAll() → Record<string, value>
  async set(key, value, updatedBy) → void   // validates, stores previous
  async applyRecommendations(changes, updatedBy) → ApplyResult  // atomic batch
  async rollback(key) → void                // revert to previous_value (one-step only in V1)
  async getHistory(key) → { current, previous, updated_at, updated_by }
}
```

### Config Resolution Order

```
API body (per-request override) > Parameter Registry > Bootstrap defaults
```

Bootstrap defaults are used only for registry initialization and as fail-safe when a key is missing. Once the registry is seeded, it is the authoritative source of defaults.

**Missing key behavior**: Return bootstrap default, log a warning. Do not fail the execution.

**Startup behavior**: If registry seeding partially fails (e.g., database temporarily unavailable), startup continues using bootstrap defaults with warnings. The service should never fail to start due to missing parameters.

### Bulk Apply Semantics

`POST /api/swarm/meta/apply` validates all changes first, then applies atomically in a single transaction. If any validation fails, no changes are applied. Every apply also emits an observation (`kind: "meta_apply"`) logging: changed keys, `updated_by`, timestamp, and optional source evaluation ID. This enables auditing of all configuration changes.

### Rollback

One-step only in V1. Each `set()` stores the previous value. `rollback(key)` swaps current ← previous. Multi-version history is deferred.

### API Endpoints

**`GET /api/swarm/meta/parameters`** — List all parameters
```json
{ "parameters": { "routing.temperature": 1.0, ... }, "count": 18 }
```

**`GET /api/swarm/meta/parameters/:key`** — Single parameter with history
```json
{
  "key": "routing.temperature",
  "value": 1.0,
  "previous_value": 0.8,
  "updated_at": "...",
  "updated_by": "admin"
}
```

**`POST /api/swarm/meta/apply`** — Apply parameter changes (atomic batch)
```json
Request: {
  "changes": [
    { "param": "routing.temperature", "value": 0.8 },
    { "param": "routing.forceWeights.blueprintPrior", "value": 0.2 }
  ],
  "updated_by": "admin"
}
Response: {
  "applied": 2,
  "changes": [
    { "param": "routing.temperature", "from": 1.0, "to": 0.8 },
    { "param": "routing.forceWeights.blueprintPrior", "from": 0.3, "to": 0.2 }
  ]
}
```

**`POST /api/swarm/meta/rollback`** — Rollback single parameter
```json
Request: { "param": "routing.temperature" }
Response: { "param": "routing.temperature", "rolledBackFrom": 0.8, "rolledBackTo": 1.0 }
```

---

## Integration: How the Three Components Connect

```
Dashboard APIs ←──── read ────── op/execution_events
                                  op/trails
                                  meta/reputation
                                  meta/trail_weights

MetaEvaluator ←──── read ────── same data as dashboard
              ────── write ────→ op/observations (kind: meta_evaluation)
              ────── output ───→ EvaluationReport (recommendations)

Parameter Registry ←── read ──── meta_parameters table
                   ←── write ──── POST /api/swarm/meta/apply (human-triggered)

Runtime ←────────── read ────── Parameter Registry (on every execution)
        ←────────── override ── API body (per-request)
```

The flow: **Observe → Analyze → Recommend → (Human reviews) → Apply → Runtime adapts**

---

## Implementation Path

### Phase 1: Parameter Registry + Schema
- Create `meta_parameters` table
- Implement ParameterRegistry class with validation
- Add bootstrap seeding on startup
- Wire runtime to read from registry

### Phase 2: Dashboard APIs
- Implement 4 dashboard endpoints
- Query directly from existing tables
- Add time-window filtering

### Phase 3: MetaEvaluator
- Implement 8 detection rules
- Build EvaluationReport generator
- Add evaluate endpoint
- Add evaluation logging

### Phase 4: Apply + Rollback
- Wire apply endpoint (atomic batch)
- Wire rollback endpoint
- Deploy and validate full loop

---

## Success Criteria

- [ ] Dashboard overview returns accurate metrics from live data
- [ ] Dashboard supports time-window filtering (24h, 7d, 30d)
- [ ] Success rate definition is consistent across all endpoints
- [ ] MetaEvaluator detects at least one issue in benchmark data
- [ ] MetaEvaluator respects minimum sample thresholds
- [ ] MetaEvaluator returns `systemStable: true` when no issues found
- [ ] Recommendations include confidence bands and evidence
- [ ] Parameter Registry validates all changes against schema
- [ ] Bulk apply is atomic (all or nothing)
- [ ] Rollback restores previous value correctly
- [ ] Runtime reads defaults from registry (not hardcoded)
- [ ] Per-request API overrides still take precedence
- [ ] Evaluation runs are logged as observations
- [ ] Full loop works: evaluate → review → apply → runtime behavior changes

---

## Document History

| Date | Version | Status |
|------|---------|--------|
| 2026-03-27 | 1.0 | Design Complete, Ready for Implementation Planning |

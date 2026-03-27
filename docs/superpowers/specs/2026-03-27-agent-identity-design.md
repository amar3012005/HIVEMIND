# Agent Identity + Reputation + Role Specialization

**Date**: 2026-03-27
**Status**: Design Document (Ready for Implementation Planning)
**Scope**: Gap B — Persistent agent profiles, reputation engine, ForceRouter V2 (social + momentum)
**Prerequisite**: Trail Executor V1 + Blueprint Extraction (complete, deployed)

---

## Executive Summary

Agent Identity makes agents first-class citizens in the cognitive runtime. Instead of stateless, disposable executors, agents become persistent entities with earned reputation, observed skills, and specialization confidence — enabling the ForceRouter V2 force terms (`socialAttraction`, `momentum`) that make routing identity-aware.

Agents are created implicitly on first execution (frictionless) or explicitly via registration (richer profiles). Reputation accumulates from execution outcomes using exponential moving averages. Registration defines intent; reputation defines reality.

---

## Design Decision: Hybrid Creation (Approach C)

- **Implicit**: When `/api/swarm/execute` is called with an unknown `agent_id`, an `OpAgent` profile is auto-created with `source: "implicit"`, `role: "generalist"`.
- **Explicit**: Agents can be registered via `POST /api/swarm/agents` with specific roles, skills, and metadata. `source: "explicit"`.
- **Reputation**: Accumulates identically for both. Every execution updates skill scores, blueprint scores, and specialization confidence.

**Why hybrid**: Implicit keeps the happy path frictionless. Explicit enables richer specialization. Identity becomes a progressive enhancement, not a gate.

---

## Data Model

### OpAgent (existing table, new fields added)

```js
{
  id: uuid,                         // internal DB ID
  agent_id: string,                 // unique human-meaningful identifier (e.g. "explorer_1")
  role: "generalist" | "explorer" | "operator" | "evaluator" | "promoter",
  model_version: string,            // "claude-opus-4-6", "groq-llama", etc.
  skills: string[],                 // declared/assigned capabilities
  status: "active" | "idle" | "suspended",
  source: "implicit" | "explicit",  // NEW: how the agent was created (immutable after creation)
  last_seen_at: Date | null,        // NEW: last execution timestamp
  created_at: Date,
  updated_at: Date,
}
```

**Schema additions needed:**
```sql
ALTER TABLE op_agents ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'implicit';
ALTER TABLE op_agents ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
```

**Key constraints:**
- `agent_id` is unique (used in API routes, not internal UUID)
- `source` is immutable after creation
- `agent_id` is immutable after creation

### MetaReputation (existing table, richer JSON content)

```js
{
  agent_id: string,                 // FK to OpAgent.agent_id
  success_rate: number,             // execution-level completion success (EMA, α=0.1)
  avg_confidence: number,           // average confidence across runs (EMA)
  skill_scores: {                   // per-tool observed performance
    "graph_query": {
      success_rate: 0.95,
      avg_latency_ms: 35,
      executions: 42,
    },
    "write_observation": {
      success_rate: 1.0,
      avg_latency_ms: 2,
      executions: 38,
    },
  },
  blueprint_scores: {               // per-blueprint execution performance
    "graph_query>write_observation": {
      success_rate: 1.0,
      executions: 15,
    },
  },
  specialization_confidence: {      // derived from behavior (advisory, not authoritative)
    explorer: 0.72,
    operator: 0.91,
    evaluator: 0.0,                 // placeholder until evaluator agents exist
  },
  recent_attempts: number,          // total executions (counter, not window)
  updated_at: Date,
}
```

**No schema migration needed** — `skill_scores` is already a JSONB column. The richer JSON structure (adding `blueprint_scores`, `specialization_confidence`) fits within the existing column.

### Distinction: Declared vs Observed

| Field | Source | Meaning |
|-------|--------|---------|
| `OpAgent.skills` | Declared (registration) | What the agent is configured to do |
| `MetaReputation.skill_scores` | Observed (execution) | What the system has evidence it does well |
| `OpAgent.role` | Declared (registration) | Intended identity |
| `MetaReputation.specialization_confidence` | Observed (execution) | Earned identity (advisory only, never overwrites role) |

---

## Component 1: ReputationEngine

### Interface

```js
class ReputationEngine {
  constructor(store) {}

  async updateFromExecution(agentId, executionResult) → void
  async getReputation(agentId) → Reputation | null
  async getSpecializationConfidence(agentId) → { explorer, operator, evaluator }
}
```

### Update Algorithm

```
updateFromExecution(agentId, result):
  rep = load reputation (or default: success_rate=0.5, skill_scores={}, recent_attempts=0)
  α = 0.1  // EMA smoothing factor

  // 1. Agent-level success (execution-level completion)
  execSuccess = (result.chainSummary.doneReason === 'tool_signaled_completion') ? 1.0 : 0.0
  rep.success_rate = rep.success_rate * (1 - α) + execSuccess * α
  rep.avg_confidence = rep.avg_confidence * (1 - α) + (execSuccess > 0.5 ? 0.9 : 0.3) * α

  // 2. Per-tool skill scores (using per-step event latencies when available)
  for each event in result.events (or reconstruct from chainSummary):
    tool = event.action_name
    existing = rep.skill_scores[tool] || { success_rate: 0.5, avg_latency_ms: 100, executions: 0 }
    toolSuccess = event.success ? 1.0 : 0.0
    existing.success_rate = existing.success_rate * (1 - α) + toolSuccess * α
    existing.avg_latency_ms = existing.avg_latency_ms * (1 - α) + event.latency_ms * α
    existing.executions++
    rep.skill_scores[tool] = existing

  // 3. Blueprint scores (if blueprint was used)
  if result.chainSummary.usedBlueprint:
    sig = result.chainSummary.blueprintChainSignature
    existing = rep.blueprint_scores[sig] || { success_rate: 0.5, executions: 0 }
    existing.success_rate = existing.success_rate * (1 - α) + execSuccess * α
    existing.executions++
    rep.blueprint_scores[sig] = existing

  // 4. Specialization confidence (derived, evidence-gated)
  rep.specialization_confidence = computeSpecialization(rep)

  // 5. Metadata
  rep.recent_attempts++
  rep.updated_at = now

  store.updateReputation(agentId, rep)
  store.updateAgentLastSeen(agentId)
```

### Specialization Confidence Derivation

```
computeSpecialization(rep):
  MIN_EVIDENCE = 10  // hard cap at 0.6 until this many executions

  explorer_score = clamp(
    (uniqueToolsUsed(rep) > 2 ? 0.3 : 0.1) +
    (rep.recent_attempts > 20 ? 0.2 : 0.0) +
    (lowBlueprintReliance(rep) ? 0.2 : 0.0) +
    (rep.success_rate * 0.3),
    0, rep.recent_attempts >= MIN_EVIDENCE ? 1.0 : 0.6
  )

  operator_score = clamp(
    (avgBlueprintSuccessRate(rep) * 0.4) +
    (latencyConsistency(rep) * 0.2) +
    (rep.success_rate * 0.4),
    0, blueprintExecutions(rep) >= MIN_EVIDENCE ? 1.0 : 0.6
  )

  evaluator_score = 0.0  // placeholder until evaluator agents exist

  return { explorer: explorer_score, operator: operator_score, evaluator: evaluator_score }
```

### When It Runs

**Synchronously** after every execution, before the response is returned. It's fast (one read, one write, no expensive computation) and reputation must be current for the next selection.

---

## Component 2: ForceRouter V2 — Social Attraction + Momentum

### New Force Terms

```js
// socialAttraction: prefer trails proven by high-reputation agents
function trustedAgentUsage(trail, reputationContext) {
  if (!reputationContext) return 0;

  // V1 proxy: use the reputation of the trail's creator/last-user
  const creatorRep = reputationContext.agentScores?.[trail.agentId];
  if (!creatorRep) return 0;

  // Cap at 0.25 to prevent runaway prestige effects
  return Math.min(creatorRep.success_rate * 0.5, 0.25);
}

// momentum: keep agent on productive path (family-aware)
function pathContinuityScore(trail, recentTrailHistory, trailFamilyKey) {
  if (!recentTrailHistory?.length) return 0;

  const lastTrailId = recentTrailHistory[recentTrailHistory.length - 1];

  // Direct continuation: same trail = high momentum
  if (trail.id === lastTrailId) return 0.8;

  // Same family: same goalId + same tool or same chainSignature
  if (trailFamilyKey) {
    const trailKey = trail.blueprintMeta?.chainSignature || trail.nextAction?.tool || '';
    if (trailKey === trailFamilyKey) return 0.3;
  }

  return 0;
}
```

### Updated Force Computation

```js
computeForces(trail, context) {
  const { goal, state, leaseInfo, queueInfo, recentTrailHistory, reputationContext } = context;
  const w = this.weights;

  // V1 forces (existing)
  const goalAttr = w.goalAttraction * (goalSimilarity + historicalGoalSuccess);
  const affordanceAttr = w.affordanceAttraction * (executableNowScore + paramBindability);
  const blueprintBoost = (active blueprint) ? (w.blueprintPrior ?? 0) : 0;
  const conflictRep = w.conflictRepulsion * (contradictionRisk + recentFailureScore);
  const congestionRep = w.congestionRepulsion * (activeLeasePressure + queueDepth + recentReusePenalty);
  const costRep = w.costRepulsion * (estimatedTokenCost + estimatedLatencyCost);

  // V2 forces (new)
  const social = (w.social ?? 0) * trustedAgentUsage(trail, reputationContext);
  const mom = (w.momentum ?? 0) * pathContinuityScore(trail, recentTrailHistory, context.trailFamilyKey);

  // Net force (social + momentum are subordinate to conflict + congestion)
  const net = goalAttr + affordanceAttr + blueprintBoost + social + mom
            - conflictRep - congestionRep - costRep;

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

### Default Weights (Conservative)

```js
forceWeights: {
  goalAttraction: 1.0,       // primary driver
  affordanceAttraction: 1.0,  // can it execute now?
  blueprintPrior: 0.3,        // proven procedures
  social: 0.2,                // NEW: modest social pull (capped at 0.25 raw)
  momentum: 0.15,             // NEW: path continuity
  conflictRepulsion: 1.0,
  congestionRepulsion: 1.0,
  costRepulsion: 1.0,
}
```

Social and momentum are intentionally low — **tiebreakers, not drivers**. Goal attraction remains dominant. Social + momentum never override strong conflict or congestion signals.

### Routing Metadata

V2 force terms are logged in execution events alongside existing force vectors:

```js
routing: {
  selectedTrailId, candidateTrailIds, temperature, strategy,
  forceVector: {
    goalAttraction, affordanceAttraction, blueprintBoost,
    socialAttraction,   // NEW: logged for auditability
    momentum,           // NEW: logged for auditability
    conflictRepulsion, congestionRepulsion, costRepulsion, net,
  }
}
```

---

## Component 3: Agent Lifecycle in ExecutionLoop

### Modified Execute Flow

```
POST /api/swarm/execute { goal, agent_id }
  │
  ├─ 1. ensureAgent(agent_id)
  │     └─ idempotent upsert: if not exists → create { source: "implicit", role: "generalist" }
  │     └─ if exists → load profile
  │     └─ race-safe: unique constraint on agent_id, upsert-or-read pattern
  │
  ├─ 2. loadReputation(agent_id)
  │     └─ returns skill_scores, specialization, overall score
  │     └─ if no reputation exists → return defaults
  │
  ├─ 3. execute(goal, agentId, config)
  │     └─ selector receives reputationContext in context
  │     └─ ForceRouter uses social + momentum terms
  │
  ├─ 4. updateReputation(agent_id, result)  [SYNCHRONOUS]
  │     └─ EMA update: success_rate, skill_scores, blueprint_scores
  │     └─ recompute specialization_confidence
  │     └─ update agent.last_seen_at
  │
  ├─ 5. storeChainRun (existing, async)
  ├─ 6. mine blueprints (existing, async)
  │
  └─ return result
```

### ensureAgent Semantics

```js
async ensureAgent(agentId, defaults = {}) {
  // Upsert with unique constraint — race-safe
  // If agent exists: return it (don't modify)
  // If agent doesn't exist: create with:
  //   role: defaults.role || "generalist"
  //   source: "implicit"
  //   status: "active"
  //   skills: []
  //   model_version: defaults.model || ""
  // Returns: agent profile
}
```

---

## API Endpoints

### `POST /api/swarm/agents` — Register explicit agent

```
Request: {
  agent_id: string (required, human-meaningful),
  role: "explorer" | "operator" | "evaluator" | "promoter" | "generalist",
  model: string,
  skills: string[],
  metadata?: object
}
Response: 201 { agent: { agent_id, role, status, source: "explicit", skills, created_at } }
Status: 409 if agent_id already exists
```

### `GET /api/swarm/agents/:agent_id` — Get agent profile + reputation

Route uses `agent_id` (human-meaningful), not internal UUID.

```
Response: {
  agent: { agent_id, role, status, source, skills, model_version, created_at, last_seen_at },
  reputation: { success_rate, avg_confidence, skill_scores, blueprint_scores, specialization_confidence, recent_attempts }
}
Status: 404 if not found
```

### `GET /api/swarm/agents` — List agents

```
Query params: ?role=operator&status=active&source=implicit
Response: {
  agents: [{
    agent_id, role, status, source, skills, last_seen_at, success_rate
  }],
  count: number
}
```

Includes `source`, `last_seen_at`, and compact `success_rate` in list view.

### `PATCH /api/swarm/agents/:agent_id` — Update agent

```
Request: { role?: string, skills?: string[], status?: string, model_version?: string }
Response: { agent (updated) }
```

**Immutable fields**: `agent_id`, `source` — cannot be changed via PATCH.

### `GET /api/swarm/executor/status` — Enhanced status

```
Response: {
  available: true,
  store: "PrismaStore",
  tools: [...],
  agents: { total: 5, active: 3, idle: 2, suspended: 0 }
}
```

---

## Store Methods

Both InMemoryStore and PrismaStore need:

```js
// Agent methods
async ensureAgent(agentId, defaults)    // idempotent upsert, returns agent
async getAgent(agentId)                  // return by agent_id (not UUID)
async listAgents(filters)               // optional { role, status, source }
async updateAgent(agentId, updates)     // partial update (respects immutable fields)
async updateAgentLastSeen(agentId)      // touch last_seen_at

// Reputation methods
async getReputation(agentId)            // return reputation or null
async updateReputation(agentId, rep)    // upsert full reputation object
```

---

## Implementation Path

### Phase 1: Schema + Store + ReputationEngine
- Add `source` and `last_seen_at` to `op_agents`
- Add agent CRUD methods to InMemoryStore and PrismaStore
- Implement ReputationEngine with EMA updates
- Tests for agent lifecycle and reputation accumulation

### Phase 2: ForceRouter V2
- Add `socialAttraction` and `momentum` force terms
- Add `reputationContext` to selector context flow
- Add social cap (0.25) and trail family momentum
- Tests for V2 force terms

### Phase 3: ExecutionLoop Integration
- Wire `ensureAgent` + `loadReputation` + `updateReputation` into execute flow
- Synchronous reputation update after execution
- Tests for implicit/explicit agent creation and reputation accumulation

### Phase 4: API Endpoints
- Agent CRUD endpoints (register, get, list, patch)
- Enhanced executor/status with agent counts
- Deploy and benchmark

---

## Success Criteria

- [ ] Implicit agent auto-created on first `/execute` call with `source: "implicit"`
- [ ] Explicit agent registered via `POST /api/swarm/agents` with `source: "explicit"`
- [ ] Reputation accumulates from execution outcomes (EMA, per-tool, per-blueprint)
- [ ] Specialization confidence gated by minimum evidence (10 executions)
- [ ] ForceRouter V2: socialAttraction uses trail creator reputation (capped at 0.25)
- [ ] ForceRouter V2: momentum uses trail family continuity
- [ ] Social + momentum are logged in routing metadata
- [ ] Social + momentum never override conflict or congestion
- [ ] Agent `source` and `agent_id` are immutable after creation
- [ ] `ensureAgent` is idempotent and race-safe
- [ ] Reputation update is synchronous in execute path
- [ ] 20-run benchmark shows reputation scores converging sensibly

---

## Document History

| Date | Version | Status |
|------|---------|--------|
| 2026-03-27 | 1.0 | Design Complete, Ready for Implementation Planning |

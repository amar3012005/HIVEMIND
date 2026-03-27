# Trail Executor: Cognitive Runtime Architecture

**Date**: 2026-03-27
**Status**: Design Document (Ready for Implementation Planning)
**Scope**: Phase 1 - Trail Execution Engine (Approach 2 → Path to Approach 3)

---

## Executive Summary

We are building a **Trail Executor** — a stateless, concurrent-safe execution runtime that turns stored reasoning trails into actionable behavior.

The executor sits between your existing Hivemind (graph + memory) and external tools, implementing a clean three-layer knowledge architecture:

- **`kg/*`** — Canonical enterprise memory (read-only during execution)
- **`op/*`** — Operational cognition (execution runtime, trails, events)
- **`meta/*`** — Control signals (scoring, decay, promotion rules)

This is **not a rewrite of your core engine**. It is a surgical extension that adds motor function to your existing nervous system.

---

## Problem Statement

### Current State

Your Hivemind has:
- ✅ Knowledge graph (Postgres + Qdrant)
- ✅ Stigmergic trails (thoughts as nodes with weighting)
- ✅ Temporal reasoning (bi-temporal storage)
- ✅ Consensus mechanisms (Byzantine-aware evaluation)

But:
- ❌ Trails are stored, not executed
- ❌ Agents cannot live inside the graph
- ❌ No promotion boundary (operational noise pollutes canonical memory)
- ❌ No agent identity or concurrency safety

### The Bottleneck

Without execution, your Hivemind is a **sophisticated memory system with no motor function**. It can reason about past actions but cannot *initiate* new ones.

The missing piece: **Trail Executor** — a runtime that:
1. Reads trails from the graph
2. Binds parameters from working state
3. Executes actions safely
4. Logs outcomes as execution events
5. Updates trail weights based on multi-signal feedback
6. Emits promotion candidates (asynchronously validated to canonical memory)

---

## Architecture Overview

### Three-Layer Knowledge Ecosystem

```
┌─────────────────────────────────────────┐
│  kg/* (Canonical Enterprise Knowledge)  │
│  - facts, entities, relationships       │
│  - temporal state, procedures           │
│  - durable, curated, high-confidence    │
└─────────────────────────────────────────┘
              ▲ (promotion)
              │ (async, validated)
              │
┌─────────────┴─────────────────────────┐
│  op/* (Operational Cognition)          │
│  - agents, goals, trails               │
│  - execution events (canonical log)    │
│  - observations, attempts              │
│  - temporary, probabilistic            │
└─────────────┬─────────────────────────┘
              │ (executor writes)
              │
┌─────────────┴─────────────────────────┐
│  meta/* (Control & Learning)           │
│  - evaluations, reputation, weights    │
│  - decay schedules, promotion rules    │
│  - agent capabilities                  │
└─────────────────────────────────────────┘
```

### Core Principle

> **Graph = Brain Tissue**
> **Executor = Motor Cortex**

Execution does not modify canonical memory. It writes to operational memory, which is then **evaluated asynchronously** before promotion to canonical facts.

---

## Detailed Architecture

### 1. Node/Edge Schema (by Namespace)

#### **`kg/*` — Canonical Knowledge (Existing, Protected)**

```typescript
kg/entities/{id}
  type: "entity"
  kind: "customer" | "api" | "service" | "policy" | "procedure"
  properties: { name, owner, status, ... }
  created_at, updated_at, version

kg/relationships/{id}
  type: "relationship"
  subject_id, predicate, object_id
  confidence, source, temporal_bounds

kg/procedures/{id}
  type: "procedure"
  name, steps[], preconditions, postconditions
  owner, approval_status, version

kg/facts/{id}  // Promoted from operational layer
  type: "fact"
  content, kind, owner
  promoted_from_op_id      // ← source execution event
  promotion_rule_id
  consensus_score          // ← how much agreement
  validated_by             // ← agent(s) that validated
  promotion_timestamp
```

#### **`op/*` — Operational Cognition (Runtime, Mutable)**

```typescript
op/agents/{id}
  type: "agent"
  agent_id, role, model, version
  skills: string[]
  status: "active" | "idle" | "error"
  created_at

op/goals/{id}
  type: "goal"
  goal_text, context, priority
  agent_id, parent_goal_id
  status: "open" | "in_progress" | "resolved"
  created_at

op/trails/{id}
  type: "trail"
  goal_id, agent_id
  steps: [                          // ← compact summary only
    { action_name, status, result_summary }
  ]
  execution_event_ids: [...]        // ← links to canonical events
  success_score, confidence
  weight, decay_rate
  created_at, last_executed_at

op/execution_events/{id}             // ← CANONICAL EVENT LOG
  type: "execution_event"
  trail_id, agent_id, step_index
  action_name, bound_params, tool_used
  result, error, latency_ms, timestamp
  success_score, confidence_delta
  created_at

op/trail_leases/{id}                 // ← NEW: Concurrency control
  type: "trail_lease"
  trail_id, agent_id
  lease_expiry_at
  created_at

op/observations/{id}
  type: "observation"
  agent_id, what_observed, context
  certainty: 0-1
  related_to_trial: id
  timestamp
```

#### **`meta/*` — Control & Learning (Signals)**

```typescript
meta/evaluations/{id}
  type: "evaluation"
  trail_id, evaluator_id
  correctness_score, efficiency_score
  reasoning, confidence
  timestamp

meta/trails_weights/{trail_id}
  type: "trail_weight"
  trail_id
  weight: number (0-1, normalized)
  components: {
    base_confidence: number,
    failure_penalty: number,
    agent_reputation_boost: number,
    novelty_discount: number,
    downstream_success_factor: number
  }
  updated_at
  next_decay_at

meta/reputation/{agent_id}
  type: "reputation"
  agent_id
  success_rate, avg_confidence
  skill_scores: { navigation: 0.8, api_calls: 0.92, ... }
  recent_attempts: 10
  updated_at

meta/promotion_candidates/{id}
  type: "promotion_candidate"
  source_event_id
  promotion_rule_id
  consensus_score
  status: "pending" | "approved" | "rejected" | "deferred"
  created_at, decided_at

meta/decay_schedules/{id}
  type: "decay_schedule"
  target_type: "trail" | "observation"
  half_life_days, min_weight
  applies_to: { namespace, kind }
```

---

### 2. Core Components

#### **TrailSelector**
```typescript
async selectBest(
  goal: string,
  context: WorkingMemory,
  agentId: string
): Promise<Trail>
```
- Queries `op/trails` for goal-relevant trails
- Ranks by `meta/trails_weights`
- Applies agent reputation weighting
- **Does NOT select**: trails with active leases (LeaseManager.isLeased())
- Returns highest-weight available trail

#### **ActionBinder**
```typescript
async bind(
  action: ActionSpec,
  context: WorkingMemory,
  state: GraphState
): Promise<BoundAction>
```
- Resolves action parameters from:
  - `workingMemory` (current execution state)
  - `kg/*` (canonical facts, if needed)
- Type-checks params against tool registry
- Returns fully bound, executable action

#### **LeaseManager** ⭐ (NEW — Concurrency Control)
```typescript
async acquireLease(
  trailId: string,
  agentId: string,
  ttl_seconds: number = 30
): Promise<Lease | null>

async renewLease(leaseId: string, ttl_seconds: number): Promise<boolean>

async releaseLease(leaseId: string): Promise<void>

isLeased(trailId: string): Promise<boolean>
```
- Prevents concurrent execution of same trail
- Short TTL (30s typical) to prevent dead locks
- **Used by**: TrailSelector (avoids leased trails), ToolRunner (renews during execution)
- Stores in `op/trail_leases`
- Prevents: duplicate work, race conditions, bad weight inflation

#### **ToolRunner**
```typescript
async run(
  action: BoundAction,
  budget: ExecutionBudget
): Promise<ToolResult>
```
- Validates action against `ToolRegistry` (permissions, params, types)
- Executes with safety guards:
  - Token budget
  - Timeout
  - Retry logic
  - Error capture
- Renews lease while executing (if long-running)
- Returns: `{ result, error, latency_ms, timestamp }`

#### **OutcomeWriter** (SYNC — Must be Fast)
```typescript
async write(
  trail: Trail,
  action: BoundAction,
  result: ToolResult,
  workingMemory: WorkingMemory
): Promise<ExecutionEvent>
```
- Writes to `op/execution_events` (canonical event log)
- Appends compact step to `op/trails`
- Updates `workingMemory` with result
- **Does NOT** call promotion (async pipeline handles that)
- Returns event ID for downstream use

#### **Evaluator**
```typescript
async scoreEvent(
  event: ExecutionEvent,
  trail: Trail,
  context: WorkingMemory
): Promise<ConfidenceScore>
```
- Scores outcome: 0-1 confidence
- Considers: correctness, efficiency, side effects
- Writes to `meta/evaluations`
- Used by WeightUpdater and PromotionMux

#### **WeightUpdater** (Multi-Signal)
```typescript
async update(
  trailId: string,
  confidence: number,
  latency: number,
  context: {
    agent: Agent,
    recent_failures: number,
    downstream_success: boolean
  }
): Promise<number>  // new weight
```

Weight calculation:
```
trail_weight = base_confidence
             × (1 - recent_failure_penalty)
             × (1 + agent_reputation_boost)
             × (1 - novelty_discount)
             × (1 + downstream_success_factor)

recent_failure_penalty = (failures_last_10_steps / 10) × 0.5
agent_reputation_boost = agent.reputation_score × 0.3
novelty_discount = 0.1 if trail_is_novel else 0
downstream_success_factor = 0.2 if future_outcomes_improved else 0
```

Writes to `meta/trails_weights`.

#### **PromotionMux** (ASYNC Emit)
```typescript
async emitCandidate(
  event: ExecutionEvent,
  confidence: number,
  rule: PromotionRule
): Promise<void>
```
- Emits to `meta/promotion_candidates` (does NOT write to `kg/*`)
- Async promotion pipeline picks it up later
- Decouples execution from canonical memory writes
- Keeps executor fast

---

### 3. Execution Loop (TrailExecutor)

```typescript
class TrailExecutor {
  async execute(
    goal: string,
    agentId: string,
    config: ExecutionConfig
  ): Promise<ExecutionResult> {

    // PHASE 1: Initialization
    const state = await graphStore.loadState(goal)
    const workingMemory = new WorkingMemory(state)
    const events: ExecutionEvent[] = []
    let step = 0

    // PHASE 2: Execution Loop
    while (step < config.maxSteps && !workingMemory.isDone()) {

      // A. SELECT: Pick best available trail
      const trail = await trailSelector.selectBest(
        goal,
        workingMemory.context,
        agentId
      )
      if (!trail) break

      // B. ACQUIRE LEASE (Concurrency Control) ⭐
      const lease = await leaseManager.acquireLease(
        trail.id,
        agentId,
        config.lease_ttl_seconds
      )
      if (!lease) {
        // Trail is locked by another agent, skip
        step++
        continue
      }

      // C. BIND: Resolve action params
      const action = await actionBinder.bind(
        trail.nextAction,
        workingMemory.context,
        state
      )

      // D. VALIDATE: Check tool registry, budgets, permissions
      const validation = toolRegistry.validate(action)
      if (!validation.ok) {
        await leaseManager.releaseLease(lease.id)
        events.push({
          type: "validation_failed",
          trail_id: trail.id,
          reason: validation.error,
          timestamp: now()
        })
        step++
        continue
      }

      // E. EXECUTE: Run tool with safety guards
      const startTime = performance.now()
      let result, error
      try {
        // Renew lease during long-running operations
        result = await toolRunner.run(
          action,
          { ...config.budget, leaseId: lease.id }
        )
      } catch (e) {
        error = e
      }
      const latency = performance.now() - startTime

      // F. WRITE EXECUTION EVENT (Canonical)
      const event: ExecutionEvent = {
        id: uuid(),
        trail_id: trail.id,
        agent_id: agentId,
        step_index: step,
        action_name: action.tool,
        bound_params: action.params,
        result: result || null,
        error: error ? error.message : null,
        latency_ms: latency,
        success: !error,
        timestamp: now()
      }
      await graphStore.writeEvent(event)  // → op/execution_events
      events.push(event)

      // G. UPDATE WORKING MEMORY
      workingMemory.incorporate(event)

      // H. SCORE OUTCOME
      const confidence = await evaluator.scoreEvent(
        event,
        trail,
        workingMemory
      )

      // I. UPDATE TRAIL (compact summary)
      await graphStore.appendTrailStep(trail.id, {
        action_name: action.tool,
        status: error ? "failed" : "success",
        result_summary: truncate(result, 200)
      })

      // J. UPDATE WEIGHT (multi-signal)
      const newWeight = await weightUpdater.update(
        trail.id,
        confidence,
        latency,
        {
          agent: agent,
          recent_failures: workingMemory.failureCount(),
          downstream_success: workingMemory.hasDownstreamSuccess()
        }
      )

      // K. EMIT PROMOTION CANDIDATE (async boundary)
      if (confidence > config.promotionThreshold) {
        await promotionMux.emitCandidate(
          event,
          confidence,
          config.promotionRule
        )
      }

      // L. RELEASE LEASE
      await leaseManager.releaseLease(lease.id)

      step++
    }

    // PHASE 3: Return
    return {
      goal,
      agentId,
      steps_executed: step,
      events_logged: events.length,
      final_state: workingMemory.snapshot(),
      trails_updated: [...],
      observations_to_promote: [...],
      next_recommended_goal: workingMemory.nextGoal()
    }
  }
}
```

---

### 4. Data Flow Summary

```
External Call (Agent)
        ↓
TrailExecutor.execute(goal, agentId)
        ├→ SELECT best trail
        ├→ ACQUIRE lease (concurrency control) ⭐
        ├→ BIND action params
        ├→ VALIDATE against tool registry
        ├→ EXECUTE tool (with lease renewal)
        ├→ WRITE execution event → op/execution_events
        ├→ EVALUATE outcome → meta/evaluations
        ├→ UPDATE trail weight → meta/trails_weights
        ├→ EMIT promotion candidate → meta/promotion_candidates (async)
        └→ RELEASE lease

        Return { steps_executed, events_logged, final_state, ... }

[SEPARATE ASYNC PROCESS]
        ↓
meta/promotion_candidates (poll / queue)
        ├→ Consensus check
        ├→ Cross-validate with kg/*
        ├→ Apply promotion rules
        ├→ APPROVE → write to kg/facts (with audit trail)
        └→ REJECT → archive to op/archive
```

---

## Key Design Decisions

### Decision 1: Async Promotion Boundary
- **Why**: Keeps executor fast, prevents canonical writes from blocking runtime
- **Trade-off**: Slight delay before facts are canonical (minutes, not ms)
- **Benefit**: Audit trail, consensus check, rollback capability

### Decision 2: Lease-Based Concurrency Control
- **Why**: Prevents duplicate work, race conditions, weight inflation
- **Trade-off**: Small overhead per execution (~100μs)
- **Benefit**: Safe for multi-agent swarms

### Decision 3: Multi-Signal Trail Weighting
- **Why**: Trails improve over time, not just on immediate success
- **Trade-off**: More computation, more state to track
- **Benefit**: Realistic behavioral learning (failure streaks, agent reputation, downstream effects matter)

### Decision 4: Compact Trail Steps, Canonical Event Log
- **Why**: Prevents trail document bloat, keeps event log as single source of truth
- **Trade-off**: Must query execution_events for full replay
- **Benefit**: Trails stay lightweight for routing; events stay auditable

### Decision 5: Three Namespaces (kg/op/meta)
- **Why**: Clear boundary between truth, behavior, and control signals
- **Trade-off**: Slightly more complex schema
- **Benefit**: Clean promotion pipeline, prevents memory pollution

---

## Implementation Path

### Phase 1A (Foundation)
- Implement schema extensions (op/*, meta/*)
- Deploy TrailSelector, ActionBinder, ToolRunner
- Deploy OutcomeWriter, basic Evaluator
- Test with single-threaded executor

### Phase 1B (Concurrency & Learning)
- Add LeaseManager
- Implement WeightUpdater (multi-signal)
- Add async PromotionMux

### Phase 1C (Production Ready)
- Timeout/retry logic
- Budget enforcement
- Error recovery
- Observability (logging, metrics)

### Phase 2 (Path to Approach 3)
- Once repeated patterns stabilize in trails
- Extract "TrailBlueprints" from common execution sequences
- Promote patterns → blueprints (Approach 3 begins)

---

## Success Criteria

✅ System is "alive" when:
- [ ] Single agent can execute trail → observe outcome → update weight
- [ ] Multiple agents can safely execute concurrently (no race conditions)
- [ ] Trail weights improve over time based on success + failure history
- [ ] Execution events are fully logged and auditable
- [ ] Promotion pipeline can validate and promote key facts to `kg/*`
- [ ] Canonical memory stays clean (no execution noise)
- [ ] Agent reputation scores emerge and affect trail weighting

---

## Open Questions for Implementation Phase

1. **Tool Registry**: What tools are available to agents initially? Where is this defined?
2. **Working Memory**: What constitutes state that agents see? How deep (context window)?
3. **Promotion Rules**: What are the initial rules for promoting facts to canonical memory?
4. **Agent Types**: What agents should we spawn first (Explorer, Evaluator, Refiner)?
5. **Observability**: What metrics/logging are critical for production?

---

## References & Research

- Stigmergy ([Wikipedia](https://en.wikipedia.org/wiki/Stigmergy))
- Multi-agent systems with virtual stigmergy ([ScienceDirect](https://www.sciencedirect.com/science/article/pii/S016764231930139X))
- Byzantine fault tolerance in distributed systems
- Context cascade memory systems (Mem0, Mem0g)
- Social force models for autonomous coordination

---

## Appendix: Component Interfaces (TypeScript)

```typescript
interface Trail {
  id: string
  goal_id: string
  agent_id: string
  steps: TrailStep[]
  execution_event_ids: string[]
  success_score: number
  confidence: number
  weight: number
  decay_rate: number
  created_at: Date
  last_executed_at?: Date
}

interface ExecutionEvent {
  id: string
  trail_id: string
  agent_id: string
  step_index: number
  action_name: string
  bound_params: Record<string, any>
  tool_used: string
  result?: any
  error?: string
  latency_ms: number
  success: boolean
  confidence_delta: number
  timestamp: Date
}

interface BoundAction {
  tool: string
  params: Record<string, any>
  schema_version: string
}

interface ExecutionConfig {
  maxSteps: number
  lease_ttl_seconds: number
  promotionThreshold: number
  promotionRule: string
  budget: ExecutionBudget
}

interface Lease {
  id: string
  trail_id: string
  agent_id: string
  lease_expiry_at: Date
  created_at: Date
}

interface ExecutionResult {
  goal: string
  agentId: string
  steps_executed: number
  events_logged: number
  final_state: WorkingMemorySnapshot
  trails_updated: string[]
  observations_to_promote: string[]
  next_recommended_goal?: string
}
```

---

---

## MASTER ROADMAP: Unlocking the Four Gaps

After Trail Execution (Gap A) is complete, here is the **ultimate checklist** for building a fully self-evolving cognitive system.

### **GAP A: Trail Execution** ✅ (Current Design)

**What it unblocks**: Agents can follow paths and execute actions

**Dependencies**: None (foundational)

**Success Criteria**:
- [ ] Single agent executes trail → observes outcome → updates weight
- [ ] Multiple agents execute concurrently without race conditions (LeaseManager works)
- [ ] Trail weights improve over time (multi-signal weighting proven)
- [ ] Execution events logged and auditable (op/execution_events canonical)
- [ ] Canonical memory stays clean (promotion boundary works)
- [ ] System is "alive" (agents doing work, not just reasoning)

**Key Components**: TrailExecutor, LeaseManager, WeightUpdater, PromotionMux

**Estimated Effort**: 2–3 weeks

---

### **GAP B: Agent Identity** ⏳ (Next Phase)

**What it unblocks**: Emergent hierarchy, specialization, trust weighting

**Depends On**: Gap A (execution must work first)

**What becomes possible**:
- Agents have persistent IDs, skills, reputation scores
- High-reputation agents' trails weighted higher
- Agents specialize (navigation, API calls, evaluation)
- Delegation: expert agents used for their domain

**New Components**:
- `AgentIdentityManager` — persistent agent profiles
- `ReputationEngine` — tracks success rate, skill scores per agent
- `SkillRegistry` — what each agent is good at
- `DelegationRouter` — routes goals to best-suited agent by skill

**New Schema**:
```typescript
op/agents/{id}
  agent_id, role, model_version
  skills: { navigation: 0.92, api_calls: 0.87, evaluation: 0.78 }
  success_rate, confidence
  recent_actions: 20
  specializations: string[]
  preferred_goal_types: string[]
  updated_at

meta/agent_capabilities/{agent_id}
  agent_id
  capability_vector: { domain → skill_score }
  training_epoch
  performance_on_each_domain: { domain → accuracy, latency, cost }
```

**Success Criteria**:
- [ ] Agents accumulate persistent reputation (doesn't reset)
- [ ] High-reputation agents' trails chosen more often
- [ ] Different agents specialize in different domains
- [ ] Evaluator agents emerge naturally (good at scoring others)
- [ ] Delegation works (system routes task to best agent)

**Estimated Effort**: 2 weeks (builds on Gap A)

---

### **GAP C: Force-Driven Routing** ⏳ (After Gap B)

**What it unblocks**: Autonomous coordination without hard-coded logic

**Depends On**: Gap A (execution) + Gap B (identity)

**What becomes possible**:
- Agents coordinate through "cognitive physics" (social force model)
- Trails exert attraction/repulsion on agents
- Contradictions create repulsion fields
- Promising ideas create attraction fields
- Emergent task routing without explicit schedulers

**Why After Gap B**: Need agent identity to understand repulsion/attraction (agent A vs agent B beliefs, not just trail abstract forces)

**New Components**:
- `ForceSimulator` — simulates social forces on reasoning space
- `AttractionField` — promising trails pull agents toward them
- `RepulsionField` — contradictions push agents away
- `MomentumTracker` — agents have inertia (stay on productive paths)
- `FieldVisualizer` (optional) — show cognitive physics space

**New Schema**:
```typescript
op/forces/{id}
  type: "force"
  source_type: "trail" | "contradiction" | "opportunity"
  source_id: trail_id
  agent_id: target_agent
  force_vector: { x, y, z }  // attraction/repulsion direction
  magnitude: number  // strength
  decay_rate: number
  created_at

meta/cognitive_space/{agent_id}
  agent_id
  current_position: { goal_domain, confidence, energy }
  forces_acting: [{ source, magnitude, direction }]
  velocity: { direction, magnitude }
  last_updated: timestamp
```

**Physics Model** (simplified):
```
For each agent:
  forces = []
  forces += attraction_to_promising_trails
  forces += repulsion_from_contradictions
  forces += momentum_from_previous_direction
  forces += agent_reputation_gradient

  net_force = sum(forces)
  next_goal = agent.position + (net_force × timestep)

  agent.move_toward(next_goal)
```

**Success Criteria**:
- [ ] Agents route themselves to compatible trails (no explicit scheduling)
- [ ] Contradictions naturally create separation (different agents pursue different paths)
- [ ] System finds emergent consensus through force fields (not voting)
- [ ] Novel trails attract exploration
- [ ] Proven trails retain momentum

**Estimated Effort**: 3 weeks (complex physics + visualization)

---

### **GAP D: Meta-Loop (Self-Evolution)** ⏳ (Final Phase)

**What it unblocks**: True self-improvement (system evolves its own rules)

**Depends On**: Gap A + Gap B + Gap C (need execution, identity, autonomous coordination)

**What becomes possible**:
- Meta-agents modify system rules (trail weights, decay rates, promotion thresholds)
- New agent types spawned automatically (system creates specialists)
- Evaluation rules improved (evaluator agents get better)
- Promotion rules tuned (what facts become durable)
- System self-modifies without human intervention

**Key Insight**: Meta-agents are agents too. They execute trails in "meta-space" (where the trail is "modify weight decay rate").

**New Components**:
- `MetaAgent` — agents that modify agent behavior
- `RuleModificationEngine` — safe rule mutations
- `AgentSpawner` — create new specialized agents
- `SafetyMonitor` — prevent degenerate mutations
- `EvaluatorEvolution` — evaluators improve their own scoring

**New Schema**:
```typescript
op/meta_agents/{id}
  type: "meta_agent"
  agent_id
  modifiable_targets: ["trail_weights", "decay_rates", "promotion_rules"]
  mutation_history: [{ rule, before, after, timestamp }]
  success_of_mutations: { rule → improvement_score }
  created_at

meta/mutation_log/{id}
  type: "mutation"
  meta_agent_id
  target_rule, mutation_type
  before_value, after_value
  rationale
  success_score, confidence
  timestamp
  approved_by: consensus_of_evaluators

meta/learnable_parameters/{id}
  type: "learnable_parameter"
  name: "decay_half_life" | "promotion_threshold" | "weight_signal_α"
  current_value: number
  bounds: { min, max }
  learning_rate: number
  gradient_accumulation: number
  updated_at
```

**Meta-Agent Execution Loop** (same as regular agents, but in meta-space):
```
MetaAgent loop:
  1. Observe system performance
  2. Identify bottleneck (e.g., "trails decay too fast")
  3. Propose rule mutation (e.g., "increase half_life from 7 days → 10 days")
  4. Execute mutation (apply new rule to subset of trails)
  5. Monitor outcome (do trails perform better?)
  6. Reinforce or revert (if improvement → keep; else → revert)
  7. Update meta-agent reputation (better at finding good mutations?)
```

**Safety Rules** (CRITICAL):
- [ ] Mutations are always reversible (keep old parameter values)
- [ ] Changes applied to subset first (A/B test before fleet-wide)
- [ ] Evaluators must consensus-approve major mutations
- [ ] Mutation rate limited (not more than N% of rules per epoch)
- [ ] Bounds enforced (parameter doesn't exceed safe range)
- [ ] Rollback mechanism always available

**Success Criteria**:
- [ ] Meta-agents spawn new specialized agents automatically
- [ ] Trail decay rates optimize over time (get better)
- [ ] Promotion rules tune themselves (fewer false positives)
- [ ] Evaluator scoring improves (meta-evaluators learn to evaluate)
- [ ] System measurably improves without human intervention
- [ ] Safety bounds respected (no degenerate mutations)

**Estimated Effort**: 4–6 weeks (complex, high-risk)

---

## **Dependency Graph**

```
  [GAP A: Execution] (Foundation)
         ↓
         └──→ [GAP B: Identity] (Agents become first-class)
                    ↓
                    └──→ [GAP C: Force Routing] (Autonomous coordination)
                               ↓
                               └──→ [GAP D: Meta-Loop] (Self-evolution)
```

**Key Rule**: Each gap builds on the previous. Skipping a gap creates problems.

---

## **Timeline Estimate**

| Gap | Effort | Start | End | Cumulative |
|-----|--------|-------|-----|-----------|
| A (Trail Execution) | 2–3w | Sprint 1 | Sprint 2 | **Week 3** |
| B (Agent Identity) | 2w | Sprint 3 | Sprint 4 | **Week 5** |
| C (Force Routing) | 3w | Sprint 5 | Sprint 7 | **Week 8** |
| D (Meta-Loop) | 4–6w | Sprint 8 | Sprint 11 | **Week 14** |

**Total**: ~3.5 months to fully self-evolving system

---

## **What You Get At Each Milestone**

### After Gap A (Trail Execution)
```
✅ System is "alive"
✅ Agents execute and learn
✅ Canonical memory stays clean
✅ Ready for production use
```

### After Gap B (Agent Identity)
```
✅ Agents specialize and delegate
✅ Emergent hierarchy emerges
✅ System gets smarter (uses experts)
✅ Trust scores improve routing
```

### After Gap C (Force Routing)
```
✅ No more hard-coded schedulers
✅ Coordination emerges from physics
✅ Contradiction naturally resolved
✅ System becomes more autonomous
```

### After Gap D (Meta-Loop)
```
✅ System self-modifies rules
✅ Meta-agents spawn new types
✅ Evaluators improve themselves
✅ True AGI-like self-evolution begins
```

---

## **Document History**

| Date | Version | Status |
|------|---------|--------|
| 2026-03-27 | 1.0 | Design Complete, Ready for Implementation Planning |
| 2026-03-27 | 1.1 | Master Roadmap Added (All Four Gaps) |


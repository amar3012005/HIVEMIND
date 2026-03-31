# CSI Architecture -- Technical Reference

HIVEMIND Cognitive Swarm Intelligence (CSI) system architecture as built.
All component descriptions, parameters, and behaviors are derived from the source code
in `core/src/executor/` and `core/src/executor/decision/`.

---

## 1. Core Thesis

Intelligence lives in the environment -- the knowledge graph, trails, and blueprints --
not in individual agents. Agents are interchangeable operators that read from and write to
shared cognitive state. The system improves through accumulated experience (trail weights,
blueprint promotion, reputation scores), not through retraining or model fine-tuning.

An agent executes goals by selecting trails, binding parameters, running tools, and
recording outcomes. Over time, repeated successful tool chains are automatically extracted
into blueprints. Agents that consistently succeed accumulate reputation, which influences
future routing decisions. The entire feedback loop is data-driven: configuration evolves
through the ParameterRegistry, not code mutation.

---

## 2. Three-Layer Knowledge Architecture

The runtime organizes all state into three namespaced layers:

### `kg/*` -- Canonical Enterprise Knowledge
Read-only during execution. Contains facts, preferences, decisions, and relationships
persisted in the memory graph (PostgreSQL + Qdrant). The ActionBinder resolves `$kg.<key>`
references against this layer. Agents never write directly to `kg/*` during execution;
promotion pipelines gate what gets elevated from operational observations to canonical knowledge.

### `op/*` -- Operational Cognition
Mutable state produced during execution. Six tables:

| Table | Purpose |
|---|---|
| `op_agents` | Registered agents with role, model version, skill manifest, status |
| `op_goals` | Goals assigned to agents, supporting hierarchical decomposition |
| `op_trails` | Weighted executable plans (raw or blueprint) attached to goals |
| `op_execution_events` | Immutable append-only event log of every step outcome |
| `op_trail_leases` | Exclusive time-bounded leases preventing concurrent trail execution |
| `op_observations` | Agent sensory inputs, inferences, environment signals |

### `meta/*` -- Control and Learning Signals
Derived state that feeds back into routing and system tuning. Six tables:

| Table | Purpose |
|---|---|
| `meta_evaluations` | Post-execution evaluations (correctness, efficiency, reasoning) |
| `meta_trail_weights` | Materialized composite weight with explainable components |
| `meta_reputation` | Per-agent EMA-based reputation scores |
| `meta_promotion_candidates` | Gated pipeline for observation-to-memory promotion |
| `meta_parameters` | Centralized runtime config with validation and rollback |
| `meta_decay_schedules` | Configurable decay half-lives for trails and observations |

---

## 3. Component Architecture

All 15 executor components live in `core/src/executor/`. Each is a single-responsibility
class injected via constructor dependency injection.

| # | Component | File | Description |
|---|---|---|---|
| 1 | **TrailExecutor** | `execution-loop.js` | Main orchestrator. Runs the select-bind-execute-write cycle up to `maxSteps` times. Handles both single-action and multi-step blueprint execution. |
| 2 | **ForceRouter** | `force-router.js` | Computes 8-dimension Social Force Model vectors for candidate trails. Selects via softmax sampling over net force scores (not argmax). |
| 3 | **TrailSelector** | `trail-selector.js` | Retrieves candidates from the graph store, filters by status and blueprint state, delegates force computation to ForceRouter, returns a routing decision. |
| 4 | **ActionBinder** | `action-binder.js` | Resolves `$ctx.*`, `$kg.*`, and `$obs.*` parameter template tokens against working memory, canonical state, and observations. Throws on unresolvable required params. |
| 5 | **ToolRegistry** | `tool-registry.js` | Strict typed tool validation. Registers tool definitions with parameter schemas, budget limits, and timeouts. Validates bound actions before execution. |
| 6 | **ToolRunner** | `tool-runner.js` | Executes bound actions with AbortController timeout, budget enforcement, and latency tracking. Returns structured `ToolExecutionResult`. |
| 7 | **OutcomeWriter** | `outcome-writer.js` | Persists immutable execution events and appends compact step summaries to the trail. Truncates large payloads to 200 chars. |
| 8 | **LeaseManager** | `lease-manager.js` | Exclusive time-bounded leases with TTL. Supports acquire, renew, release, and expired-lease cleanup. Prevents concurrent execution of the same trail. |
| 9 | **WeightUpdater** | `weight-updater.js` | Computes multi-signal composite trail weight from six factors: base confidence, failure penalty, agent reputation boost, novelty discount, downstream success, and cost factor. Stores components alongside final score for explainability. |
| 10 | **PromotionMux** | `promotion-mux.js` | Emits promotion candidates asynchronously. Deduplicates via `event_id:rule_id:goal_id` composite key. |
| 11 | **ChainMiner** | `chain-miner.js` | Scans execution history for repeated successful tool chains. Canonicalizes sequences into chain signatures, evaluates against thresholds (min occurrences, min success rate, max latency), creates or auto-activates blueprint trails. |
| 12 | **ReputationEngine** | `reputation-engine.js` | EMA-based agent reputation. Tracks agent-level success rate, per-tool skill scores, per-blueprint scores, and three-way specialization confidence (explorer / operator / evaluator). |
| 13 | **ParameterRegistry** | `parameter-registry.js` | Centralized configuration with typed validation (min/max bounds), bootstrap defaults, atomic multi-parameter apply, and single-key rollback. |
| 14 | **Dashboard** | `dashboard.js` | Read-only analytics over `op/*` and `meta/*` tables. Provides overview, executions, blueprints, and agents views with windowed time filtering (24h / 7d / 30d). |
| 15 | **MetaEvaluator** | `meta-evaluator.js` | Batch analysis with five detection rules. Produces actionable parameter recommendations. Requires minimum sample sizes before issuing recommendations. |

---

## 4. Force Routing Model (Social Force Model)

The ForceRouter computes a force vector for each candidate trail across 8 dimensions.
The net force determines selection probability via softmax sampling.

### Force Dimensions

| Dimension | Default Weight | Sub-signals | Description |
|---|---|---|---|
| `goalAttraction` | 1.0 | `goalSimilarity` (word overlap) + `historicalGoalSuccess` (stored score) | Pulls toward trails semantically aligned with the goal and historically successful. |
| `affordanceAttraction` | 1.0 | `executableNowScore` (has nextAction + active) + `paramBindabilityScore` (template keys present in state) | Pulls toward trails that can execute immediately with available data. |
| `blueprintPrior` | 0.3 | Binary: 1.0 if trail is an active blueprint, else 0 | Modest boost for proven procedures. Not dominant by design. |
| `socialAttraction` | 0.2 | `trustedAgentUsage`: creator's reputation * 0.5, capped at 0.25 | Prefers trails from high-reputation agents. Capped to prevent runaway prestige effects. |
| `momentum` | 0.15 | `pathContinuityScore`: same trail = 0.8, same family = 0.3, unrelated = 0 | Encourages continuing productive paths. |
| `conflictRepulsion` | 1.0 | `contradictionRisk` (1 - confidence) + `recentFailureScore` (proportion of failed steps) | Repels away from low-confidence and recently-failed trails. |
| `congestionRepulsion` | 1.0 | `activeLeasePressure` + `queueDepthPressure` (depth/10, capped at 1.0) + `recentReusePenalty` (decays: 1.0, 0.7, 0.5, 0.3) | Repels away from busy, queued, or recently-used trails. |
| `costRepulsion` | 1.0 | `estimatedTokenCost` (0.1 placeholder) + `estimatedLatencyCost` (0.1 placeholder) | Repels away from expensive operations. V1 uses flat estimates. |

### Net Force Calculation

```
F_net = goalAttraction + affordanceAttraction + blueprintPrior + socialAttraction + momentum
      - conflictRepulsion - congestionRepulsion - costRepulsion
```

### Selection: Softmax Sampling

The system uses **softmax sampling with temperature**, not argmax. This is deliberate:
controlled exploration prevents the system from collapsing onto a single trail.

```
logits[i] = F_net[i] / temperature
P[i] = exp(logit[i] - max_logit) / sum(exp(logits - max_logit))
```

Selection is probabilistic via CDF sampling over the resulting probability distribution.
Temperature is configurable through the ParameterRegistry (default: 1.0, range: 0.01 - 10.0).

---

## 5. Blueprint Lifecycle

Blueprints progress through a defined lifecycle:

```
[repeated raw execution] --> candidate detection --> promotion --> active --> execution --> deprecation
```

### ChainMiner: Pattern Extraction

1. **Gather chain runs** for a goal (bounded lookback window, default 50).
2. **Filter** to runs that completed successfully (`doneReason === 'tool_signaled_completion'`)
   with success rate above threshold.
3. **Canonicalize** tool sequences into chain signatures (e.g., `detect>classify>link>store`).
4. **Group by signature** and evaluate against thresholds:
   - `minOccurrences`: 3 (default)
   - `minSuccessRate`: 0.9 (default)
   - `maxAvgLatencyMs`: 5000 (default)
5. **Deduplicate** against existing blueprints with the same chain signature.
6. **Create blueprint trail** with inherited parameter templates from raw trails.
7. **Auto-activate** if `autoActivate` is true (default). Otherwise, create as `candidate`.

### Blueprint Execution

When the TrailExecutor selects a blueprint trail, it iterates through the
`blueprintMeta.actionSequence` array, executing each action in order. Working memory
flows between steps (tool outputs merge into context). A failure at any step halts
the blueprint and records the failure reason.

### Blueprint States

- `candidate` -- Detected pattern, awaiting promotion or manual approval.
- `active` -- Available for selection by TrailSelector. Only active blueprints participate in routing.
- `deprecated` -- Detected by MetaEvaluator when a blueprint is never selected over a sufficient window.

---

## 6. Agent Identity and Reputation

### Hybrid Agent Creation

Agents are created through two paths:
- **Implicit**: Auto-created on first `execute()` call via `store.ensureAgent(agentId)`.
  Source is recorded as `"implicit"`.
- **Explicit**: Registered via the `/api/swarm/agents` POST endpoint with declared role,
  model version, and skill manifest. Source is recorded as `"explicit"`.

Suspended agents are rejected at execution time (no steps run, immediate return).

### EMA-Based Reputation

The ReputationEngine updates reputation after every execution using exponential moving
averages (alpha = 0.1):

**Agent-level metrics:**
- `success_rate`: EMA of per-execution success (1.0 if `tool_signaled_completion`, else 0.0)
- `avg_confidence`: EMA weighted toward 0.9 on success, 0.3 on failure

**Per-tool skill scores:**
- `success_rate`: EMA per tool
- `avg_latency_ms`: EMA per tool
- `executions`: monotonic counter

**Per-blueprint scores:**
- `success_rate`: EMA per chain signature
- `executions`: monotonic counter

### Specialization Confidence

Three specialization archetypes scored from observed behavior:

| Archetype | Scoring Factors |
|---|---|
| `explorer` | Unique tool count, execution volume, low blueprint usage, overall success rate |
| `operator` | Blueprint success rate, overall success rate, execution count |
| `evaluator` | Reserved (0.0 in V1) |

Confidence is capped at 0.6 until the agent accumulates at least 10 execution events
(`MIN_EVIDENCE`), preventing premature specialization claims.

---

## 7. Meta-Loop

The meta-loop is the system's self-tuning mechanism:

```
Dashboard (observe) --> MetaEvaluator (analyze) --> ParameterRegistry (tune)
```

### Dashboard: Observe

Read-only analytics with four views:
- **overview**: execution counts, success rate, latency, done-reason distribution,
  blueprint stats (active/candidate/deprecated, usage rate), agent stats, force contributions.
- **executions**: filtered event log (by agent, goal, time window).
- **blueprints**: per-blueprint success rate, execution count, latency, weight.
- **agents**: per-agent role, status, success rate, top skills, specialization scores.

### MetaEvaluator: Analyze

Five detection rules, each gated by minimum sample sizes:

| Rule | Min Samples | Trigger | Severity |
|---|---|---|---|
| `high_failure_rate` | 10 | Success rate below 70% | alert |
| `exploration_too_low` | 20 | Route diversity below 0.3 | info |
| `exploration_too_high` | 20 | Route diversity above 0.9 with success below 70% | warning |
| `blueprint_stagnation` | 20 | Active blueprint never selected in recent window | info |
| `social_convergence` | 20 | Single agent's trails dominate >60% of selections | warning |

Each issue includes evidence (sample size, observed values) and a recommendation
(parameter adjustment with from/to values, or manual review).

### ParameterRegistry: Tune

20 parameters across four categories, all with typed validation and rollback:

**Routing** (9 params): `temperature`, force weights for all 8 dimensions.
**Blueprint** (5 params): `minOccurrences`, `minSuccessRate`, `maxAvgLatencyMs`, `lookbackRuns`, `autoActivate`.
**Reputation** (3 params): `emaAlpha`, `minEvidence`, `maxConfidenceWithoutEvidence`.
**Execution** (3 params): `defaultMaxSteps`, `defaultBudgetMaxTokens`, `defaultPromotionThreshold`.

Key capabilities:
- **Atomic multi-apply**: Validates all changes before applying any (all-or-nothing).
- **Rollback**: Restores previous value for any parameter.
- **Audit trail**: Every change records `updated_by` and `previous_value`.
- **Bootstrap defaults**: Seeded on first startup, never overwritten if already set.

Policy evolution happens through configuration changes, not code mutation. The MetaEvaluator
recommends; a human or higher-level system applies.

---

## 8. Cross-Project Connections (Latest)

The Faraday agent now detects related memories across different projects and creates
`Extends` relationships to link them. This enables organization-wide knowledge graph connectivity.

### LLM-Powered Cluster Analysis

Faraday sends semantic clusters to Groq with full UUIDs:
```
Cluster 1: ["memory-uuid-1", "memory-uuid-2", "memory-uuid-3"]
  - Title: "GitHub deployment"
  - Keywords: deployed, shipped, production
  - Sources: [project:backend, project:infrastructure]

Question to LLM:
  "Analyze this cluster. Are these duplicates? Update chains? Related ideas?
   Show CROSS_PROJECT if ideas link across projects."
```

LLM detects:
- DUPLICATES: Same content, different memories
- UPDATE_CHAIN: Old→New version pairs
- CONFLICTS: Contradictory facts
- MERGE: Which should be canonical
- CROSS_PROJECT: Same topic across projects → recommendation to link

### Cross-Project Linking

When Faraday detects CROSS_PROJECT:
1. LLM identifies the two related memories from different projects
2. Turing creates `Extends` relationship with `type: "cross_project"`
3. Relationship tagged with source projects: `[project:X, project:Y]`
4. Both memories remain canonical (not merged), but now discoverable together

**Example**:
```
Project: backend
  Memory: "PostgreSQL upgrade to 15 completed"
  UUID: 550e8400-e29b-41d4-a716-446655440000

Project: infrastructure
  Memory: "Updated prod DB to version 15"
  UUID: 6ba7b810-9dad-11d1-80b4-00c04fd430c8

Relationship: Extends
  source: 550e8400... (backend)
  target: 6ba7b810... (infrastructure)
  type: cross_project
```

**Impact**: Organization-wide memory graph. Single query retrieves related memories from all projects.

---

## 8.1 Decision Intelligence Wedge

The Decision Intelligence module detects, classifies, corroborates, and stores
organizational decisions from cross-platform content (Gmail, Slack, GitHub).
It operates as a set of tools within the trail executor framework.

### Hybrid Detection Pipeline

```
[raw content] --> heuristic detection (high recall, low cost)
              --> LLM classification (high precision, Groq API)
              --> evidence linking (cross-platform search)
              --> merge-on-key storage
```

### Two-Tier Signal System

**Strong signals** (high confidence, +0.25 each):
`decided`, `approved`, `agreed`, `chosen`, `chose`, `picked`, `selected`, `went with`,
`accepted`, `declined`, `rejected`, `assigned`, `confirmed`, `merged`, `deferred`,
`overridden`. Platform-specific: `lgtm`, `sign off` (Gmail); `shipped`, `deployed` (Slack);
`closed`, `fixed` (GitHub). GitHub event types (`pull_request.merged`, `issues.closed`,
`pull_request_review.submitted`) add +0.35.

**Weak signals** (proposals/leanings, +0.15 each):
`I think we should`, `let's go with`, `leaning toward`, `prefer`, `opting for`,
`prioritizing`, `taking ownership`, `bump to p0-p3`.

**Confidence modifiers**:
- Questions reduce confidence (0.10 if strong signals present, 0.40 if no signals).
- Hedging phrases (`maybe`, `perhaps`, `not sure`) reduce by 0.10 each.
- Minimum candidate threshold: 0.10 confidence with at least one signal.

### Decision Classification (LLM)

Only called for items that pass heuristic detection. Uses Groq API for structured extraction:
- `is_decision`: boolean confirmation
- `decision_type`: choice / approval / rejection / priority / assignment / resolution / policy
- `decision_statement`: concise statement of what was decided
- `confidence`: classifier confidence score

### Evidence Linking

Cross-platform search via the memory store. For each decision, searches for:
- Supporting evidence (corroborating mentions across platforms)
- Conflicting evidence (contradictory signals)
- Related decisions (existing decisions on the same topic)

Returns an `evidence_strength` score used in promotion rules.

### Fact-Memory Architecture

Every extracted fact becomes its own searchable memory, independent of the parent:

```
Input: "I attended the NotebookLM webinar on March 15, 2026."

MemoryProcessor extracts:
  - factSentences: ["attended the NotebookLM webinar", "March 15, 2026"]
  - entities: {people: [], orgs: ["NotebookLM"], locations: []}
  - dates: {absolute: ["2026-03-15"], relative: ["today minus X"]}
  - eventDates: [ISO8601("2026-03-15")]

Memory 1 (Parent):
  type: observation
  content: "I attended the NotebookLM webinar on March 15, 2026."
  is_latest: true

Memory 2 (Fact: Event):
  type: fact
  content: "Attended NotebookLM webinar"
  event_dates: ["2026-03-15"]
  tags: [extracted-fact, event]
  Relationship(parent, this): Extends

Memory 3 (Fact: Organization):
  type: fact
  content: "NotebookLM - AI document analysis platform"
  tags: [extracted-fact, organization]
  Relationship(parent, this): Extends
```

**Vectors**:
- Fact 1: Contextual embedding of "attended webinar" + full parent content
- Fact 2: Contextual embedding of "NotebookLM" + full parent content
- Both vectors are independent, can be searched separately
- Payload stored ONLY for parent (deduplication)

**Benefit**:
- Fact 1 searchable by "webinar" or "events"
- Fact 2 searchable by "NotebookLM" or "organizations"
- Parent still queryable for full context
- 3 memories per input instead of 8 (smart dedup + fact filtering)

### Smart Ingestion (Search-Before-Store)

Before storing new fact-memories, search existing:

```
New input: "We use NotebookLM for document analysis"

Extract facts:
  1. "NotebookLM" (organization)
  2. "document analysis" (tool use)

For each fact:
  1. Search vector db: vector_similarity > 0.85?
  2. Search keyword db: exact match on fact content?
  3. If found: skip storage, create Extends relationship
  4. If not found: store new fact-memory

Result: Real-time deduplication, 50% fewer redundant fact-memories
```

**Configuration**:
```javascript
{
  smartIngest: true,
  searchBeforeStoreThreshold: 0.85,
  trivialFactFiltering: true,        // Skip low-novelty facts
  skipObservationsWhenFacts: true    // Save space
}
```

### Merge-on-Key Deduplication

Decisions are keyed by `generateDecisionKey(project, decision_statement)`. When a new
decision matches an existing key, the store merges rather than duplicates: updates
confidence, appends evidence, and preserves the provenance chain.

### Provenance Chain

Every stored decision records:
- Source platform, session, and message IDs
- Detection signals and confidence
- Classification output
- Linked evidence with per-item scores
- Decision status (`candidate` or `validated` based on confidence and cross-platform count)

Recall queries return decisions ranked by a multi-signal score combining recency,
confidence, evidence strength, and semantic relevance.

### Decision Tools (registered in ToolRegistry)

| Tool | Description |
|---|---|
| `detect_decision_candidate` | Heuristic pattern matching on raw content |
| `classify_decision` | LLM-based confirmation and structured extraction |
| `link_evidence` | Cross-platform evidence search for corroboration |
| `store_decision` | Persist decision with merge-on-key deduplication |
| `recall_decision` | Provenance-aware decision retrieval with ranking |

---

## 9. Database Schema

The CSI runtime uses 12 tables in PostgreSQL (defined in `core/prisma/schema.prisma`),
organized by namespace:

### Operational (`op/*`) -- 6 tables

| Model | Table | Primary Key | Key Columns |
|---|---|---|---|
| `OpAgent` | `op_agents` | `id` (uuid) | `agent_id` (unique), `role`, `model_version`, `skills` (JSON), `status`, `source` |
| `OpGoal` | `op_goals` | `id` (uuid) | `goal_text`, `context` (JSON), `priority`, `agent_id`, `parent_goal_id`, `status` |
| `OpTrail` | `op_trails` | `id` (uuid) | `goal_id`, `agent_id`, `status`, `next_action` (JSON), `steps` (JSON), `kind` (raw/blueprint), `blueprint_meta` (JSON), `weight`, `confidence`, `decay_rate` |
| `OpExecutionEvent` | `op_execution_events` | `id` (uuid) | `trail_id`, `agent_id`, `step_index`, `action_name`, `bound_params` (JSON), `result` (JSON), `error`, `latency_ms`, `success`, `routing` (JSON) |
| `OpTrailLease` | `op_trail_leases` | `id` (uuid) | `trail_id` (unique), `agent_id`, `acquired_at`, `expires_at`, `heartbeat_at` |
| `OpObservation` | `op_observations` | `id` (uuid) | `agent_id`, `kind`, `content` (JSON), `certainty`, `source_event_id`, `related_to_trail` |

### Meta (`meta/*`) -- 6 tables

| Model | Table | Primary Key | Key Columns |
|---|---|---|---|
| `MetaEvaluation` | `meta_evaluations` | `id` (uuid) | `trail_id`, `evaluator_id`, `correctness_score`, `efficiency_score`, `reasoning`, `confidence` |
| `MetaTrailWeight` | `meta_trail_weights` | `trail_id` | `weight`, `components` (JSON: base_confidence, failure_penalty, agent_reputation_boost, novelty_discount, downstream_success_factor), `next_decay_at` |
| `MetaReputation` | `meta_reputation` | `agent_id` | `success_rate`, `avg_confidence`, `skill_scores` (JSON), `recent_attempts` |
| `MetaPromotionCandidate` | `meta_promotion_candidates` | `id` (uuid) | `source_event_id`, `trail_id`, `promotion_rule_id`, `observations` (JSON), `confidence`, `status`, `dedupe_key` (unique) |
| `MetaParameter` | `meta_parameters` | `key` (string) | `value` (JSON), `updated_by`, `previous_value` (JSON) |
| `MetaDecaySchedule` | `meta_decay_schedules` | `id` (uuid) | `target_type`, `half_life_days`, `min_weight`, `applies_to` (JSON) |

---

## 10. API Surface

All CSI endpoints are served under `/api/swarm/` via the main HTTP server
(`core/src/server.js`). Authentication is handled by the server's middleware layer.

### Execution

| Method | Path | Description |
|---|---|---|
| POST | `/api/swarm/execute` | Execute a goal. Accepts `goal`, `agentId`, `config` (maxSteps, budget, routing). Returns `ExecutionResult` with chain summary. |
| GET | `/api/swarm/executor/status` | Returns executor readiness, registered tool count, and store type. |

### Knowledge Graph / Trails

| Method | Path | Description |
|---|---|---|
| POST | `/api/swarm/thought` | Create a new thought/trail in the knowledge graph. |
| POST | `/api/swarm/trace` | Trace connections for a given thought. |
| POST | `/api/swarm/follow` | Follow/advance a trail. |
| POST | `/api/swarm/prune` | Prune low-weight or decayed trails. |
| GET | `/api/swarm/trails` | List trails with optional goal and status filters. |

### Blueprints

| Method | Path | Description |
|---|---|---|
| POST | `/api/swarm/blueprints/mine` | Trigger ChainMiner for a goal. Returns candidates created, activated, and skipped counts. |
| GET | `/api/swarm/blueprints` | List all blueprints with state and execution stats. |
| PATCH | `/api/swarm/blueprints/:id` | Update blueprint state (activate, deprecate). |

### Agents

| Method | Path | Description |
|---|---|---|
| POST | `/api/swarm/agents` | Register a new agent (explicit creation). |
| GET | `/api/swarm/agents` | List all agents with reputation summaries. |
| GET | `/api/swarm/agents/:agent_id` | Get single agent details including full reputation. |

### Dashboard

| Method | Path | Description |
|---|---|---|
| GET | `/api/swarm/dashboard/overview` | System-wide metrics with windowed time filtering. |
| GET | `/api/swarm/dashboard/executions` | Execution event log with agent/goal/window filters. |
| GET | `/api/swarm/dashboard/blueprints` | Per-blueprint performance metrics. |
| GET | `/api/swarm/dashboard/agents` | Per-agent performance and specialization data. |

### Meta / Tuning

| Method | Path | Description |
|---|---|---|
| POST | `/api/swarm/meta/evaluate` | Run MetaEvaluator batch analysis. Returns issues and parameter recommendations. |
| GET | `/api/swarm/meta/parameters` | List all current parameter values (bootstrap defaults merged with overrides). |
| GET | `/api/swarm/meta/parameters/:key` | Get single parameter value with history (previous value, updated_by). |
| POST | `/api/swarm/meta/apply` | Apply parameter recommendations (atomic multi-change). |
| POST | `/api/swarm/meta/rollback` | Rollback a parameter to its previous value. |

### Decision Intelligence Tools

Decision intelligence operates through the trail executor's tool system rather than
dedicated HTTP endpoints. Decisions are detected, classified, linked, and stored when
the executor runs the `capture_decision` goal. Recall is triggered via the
`recall_decision` goal. Both goals have pre-seeded trails covering platform-specific
detection (Gmail, Slack, GitHub), classification, evidence linking, and storage.

---

## Appendix: Execution Loop Phases

The `TrailExecutor.execute()` method runs three phases:

**Phase 1 -- Initialization**
- Load canonical state from store (`kg/*` facts).
- Initialize working memory (context, observations, trail history, failure count).
- Ensure agent exists (auto-create if implicit). Reject suspended agents.
- Load agent reputation for routing context.

**Phase 2 -- Execution Loop** (up to `maxSteps` iterations)
- A. **SELECT**: TrailSelector retrieves candidates, computes forces, softmax samples.
- B. **ACQUIRE LEASE**: LeaseManager acquires exclusive lease. Skip trail if contested.
- C. **BIND**: ActionBinder resolves `$ctx.*`, `$kg.*`, `$obs.*` tokens. For blueprints,
  binds each action in the sequence.
- D. **EXECUTE**: ToolRunner runs the bound action with timeout and budget enforcement.
- E. **WRITE**: OutcomeWriter persists immutable event and appends step summary to trail.
- F. **UPDATE MEMORY**: Merge tool output into working memory context. Check for
  `done === true` signal.
- G. **UPDATE WEIGHT**: WeightUpdater computes and persists composite trail weight.
- H. **EMIT PROMOTION**: PromotionMux emits candidate if confidence exceeds threshold.
- I. **RELEASE LEASE**: Always releases in `finally` block.

**Phase 3 -- Return**
- Build chain summary (tool sequence, trail sequence, success rate, latency, blueprint usage).
- Update agent reputation from execution outcome.
- Return `ExecutionResult` with all metadata.

Errors in any single step do not crash the loop. The executor logs the failure,
increments `failuresCount`, and continues to the next step.

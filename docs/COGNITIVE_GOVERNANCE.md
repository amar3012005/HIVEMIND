# Cognitive Governance Agents — Architecture, Operation, and Memory Health

> Faraday · Feynman · Turing — three resident agents that own the cognitive
> layer of HIVEMIND. They scan the graph, hypothesize patterns, verify
> against evidence, and write the distilled cognitive layer (canonicals,
> bridges, compressions) that powers top-down recall.

---

## 1. Three-Layer Memory Model

HIVEMIND organizes memory in three layers, top-to-bottom:

```
┌──────────────────────────────────────────────────────────┐
│  COGNITIVE LAYER  — governance-owned                     │
│    cognitive_layer_role IN ('canonical','bridge',        │
│                              'compression','reflection') │
│    Surfaced FIRST by recall (×1.6/1.4/1.3/1.1 boost)     │
├──────────────────────────────────────────────────────────┤
│  MEMORY LAYER  — facts, decisions, preferences, events    │
│    memory_type IN ('fact','decision','preference',       │
│                    'event','goal','lesson',              │
│                    'relationship','synthesis','summary', │
│                    'conversation')                        │
├──────────────────────────────────────────────────────────┤
│  EVIDENCE LAYER  — raw documents, chunks, source rows     │
│    knowledge_documents + knowledge_segments + Qdrant     │
└──────────────────────────────────────────────────────────┘
```

The cognitive layer is **derived** — never primary. Every cognitive memory
must trace back to evidence through `Derives` relationships. This makes
the layer fully reversible (`rollback` endpoint).

---

## 2. The Three Agents

| Agent | Role | Outputs |
|---|---|---|
| **Faraday** | Explorer | `graph_observation`, `anomaly_candidate`, `code_smell`, `risk_candidate`, `reasoning_trail`, `llm_cluster_analysis` |
| **Feynman** | Analyst | `hypothesis` — explains Faraday's trails as testable claims |
| **Turing** | Verifier | `verification`, `merge_candidate`, `relationship_candidate`, `noise_reduction_candidate`, `promotion_candidate` — and now invokes cognitive-tools to write canonical/bridge/compression |

**Personas (from contract):**
- Faraday — restless graph scout, high-recall, skeptical of silence
- Feynman — patient explainer, turns clusters into testable mechanisms
- Turing — adversarial skeptic, only promotes findings that reshape the graph safely

### 2.1 Pipeline

```
┌───────────────┐  trail   ┌────────────┐ hypothesis ┌────────────┐
│   Faraday     │ ───────► │  Feynman   │ ─────────► │   Turing    │
│  (scan +      │          │ (explain)  │            │ (verify +   │
│   anomaly)    │          │            │            │  emit)      │
└───────────────┘          └────────────┘            └──────┬──────┘
                                                            │
                                                            ▼
                                              ┌──────────────────────────┐
                                              │ cognitive-tools registry │
                                              │  canonical_synthesis     │
                                              │  bridge_synthesis        │
                                              │  compression             │
                                              └──────────────────────────┘
                                                            │
                                                            ▼
                                              ┌──────────────────────────┐
                                              │ governance_action_log     │
                                              │  status: proposed         │
                                              └──────────────────────────┘
                                                            │
                                              ┌─────────────┴────────────┐
                                              ▼                           ▼
                                  POST .../approve            POST .../reject
                                              │                           │
                                              ▼                           ▼
                                  GraphActionExecutor                   logged
                                  → tool.execute()
                                      LLM rewrite
                                      restatement guard
                                      Jaccard dedup
                                      write Memory
                                      stamp cognitive_layer_role
                                      _linkDerivesEdges
                                      recordCooldown
                                              │
                                              ▼
                                  status: applied
                                              │
                              optional POST .../rollback/:batch_id
                                              ▼
                                  status: reverted
```

### 2.2 Scheduler

`ResidentAgentScheduler` (`core/src/resident/scheduler.js`) ticks every
`GOVERNANCE_INTERVAL_MS` (default 30 min). On each tick it:

1. Lists all active orgs via `user_organizations.is_active`
2. For each org: `runFullCycle({ orgId, scope: 'organization', trigger: 'scheduler' })`
3. Row-level cycle lock (`governance_agent_state.agent_name='governance-cycle'`)
   prevents concurrent ticks across replicas

Env-gated via `ENABLE_GOVERNANCE_SCHEDULER=true`.

---

## 3. Cognitive Layer Ownership

Before Phase 4, the cognitive layer was written by `cognition-loop` — a
hard-coded background process. Phase 4 moved ownership to the governance
agents through a **tool layer** that wraps the proven cognition-loop helpers.

### 3.1 The Tool Layer

`core/src/cognitive-tools/`:

| File | Purpose |
|---|---|
| `base-tool.js` | Abstract `CognitiveTool` class + `clusterHash`, `jaccard`, `isRestatement` (trigram overlap), `capConfidence` (revision dampening), `isOnCooldown`, `recordCooldown`, `findExistingByHash`, `hasOpenProposal` |
| `canonical-synthesis-tool.js` | Writes canonical-fact memories. Triggers ≥2 likely_true verifications sharing ≥1 evidence id. |
| `bridge-synthesis-tool.js` | Writes cross-cluster bridge memories. Triggers 2 disjoint clusters sharing an entity tag. |
| `compression-tool.js` | Writes deterministic lossless summaries. Triggers ≥3 verifications per topic with ≥3 evidence. |
| `registry.js` | Singleton lazy-loads cognition-loop helpers and exposes `assessAll()` to Turing. |

### 3.2 Tool Contract

Every cognitive tool implements:

```js
class CognitiveTool {
  get name()           // → 'canonical_synthesis' | 'bridge_synthesis' | 'compression'
  get cognitiveRole()  // → 'canonical' | 'bridge' | 'compression'

  async assess({ verifications, orgId }):
    // Pure read. Decides applicability + computes cluster_hash.
    { applicable, cluster_hash, evidence_ids, topic, confidence, reason? }

  async execute({ orgId, userId, ..., cluster_hash, dryRun }):
    // Side-effectful. Runs cooldown re-check → LLM rewrite →
    // restatement guard → Jaccard dedup → write → derives edges →
    // recordCooldown.
    { status, memory_id, content_preview, tokens_used }
}
```

### 3.3 Cluster Hashing & Cooldown

Every tool computes a stable `cluster_hash` (sha256-48) keyed by topic +
sorted evidence_ids. The hash drives three guards:

1. **Cooldown** — `governance_agent_state.config.cooldown_map[orgId:hash]`
   stores the last write time. New proposals are skipped if within window
   (canonical 6h, bridge/compression 12h). Auto-prunes entries >7 days old.

2. **Open-proposal dedup** — `hasOpenProposal(orgId, hash, type, 6h)`
   queries `governance_action_log` for `status IN ('proposed','approved')`
   rows with matching `cluster_hash` in `before_snapshot`. If found, the
   tool's `assess()` returns `{applicable: false, reason: 'open_proposal_exists'}`.
   Prevents the same cluster being re-proposed every scheduler tick until
   the user approves or rejects.

3. **Delta-update** — `findExistingByHash` returns any existing canonical
   with the same hash. Confidence is dampened on each revision via
   `capConfidence(raw, revision)` (5% per revision, capped at 40%).

### 3.4 Quality Gates

Each tool's `execute()` runs these before write:

| Gate | Threshold | Failure action |
|---|---|---|
| Cooldown re-check | per-tool hours | skip with `reason: 'cooldown'` |
| LLM confidence floor | 0.7 (canonical/bridge) | skip with `reason: 'confidence_below_floor'` |
| Restatement guard | 60% trigram overlap with any single source | skip with `reason: 'restatement_detected'` |
| Evidence-set Jaccard | ≥80% overlap with same-topic canonical | skip with `reason: 'evidence_overlap_with_existing'` |
| LLM call | gpt-oss-120b primary, 20b fallback | skip with `reason: 'llm_empty'` |

Compression is deterministic — it uses `_buildLosslessSummary` (no LLM)
and only enforces cooldown + hash-dedup.

---

## 4. Memory Graph Health

The agents own the graph's structural health through these mechanisms:

### 4.1 Top-Down Recall

`persisted-retrieval.js` applies a per-role multiplier on every recall:

```
canonical    × 1.6
bridge       × 1.4
compression  × 1.3
reflection   × 1.1
```

A canonical with score 4.6 outranks a raw evidence memory at score 4.0.
This is how cognitive synthesis actually steers user-facing answers.

### 4.2 Derives Edges

Every cognitive memory writes `Relationship.type='Derives'` from itself
to each evidence member. This makes the cognitive layer:

- **Traceable** — recall can hop from canonical → evidence
- **Reversible** — rollback walks the edges
- **Auditable** — `MATCH (c)-[:Derives]->(e)` answers "which evidence
  justifies this canonical?"

### 4.3 Reflection Memories

After every cycle, `runFullCycle` writes a Memory with
`cognitive_layer_role='reflection'` summarizing batch outcome
(observations counts, proposals persisted, latency, ok/partial). These
land in `cognitive_layer_role='reflection'` rows and surface in recall at
×1.1 — turning the system's self-evaluation into queryable knowledge.

### 4.4 Cluster Hygiene

When Turing emits a `compression` proposal and the user approves:

1. N evidence memories are summarized into a single `cognitive_layer_role='compression'` memory
2. Derives edges connect the summary → originals
3. Recall surfaces the summary first (×1.3 boost)
4. Originals stay in the graph (no destructive deletion)
5. Future cycles see the cluster as "already compressed" via cluster_hash

Over time, this reduces recall noise without losing evidence — the
compressed view dominates surface area, raw evidence remains for audit.

### 4.5 Connection Density

`bridge_synthesis` creates explicit cross-cluster links when two distinct
likely_true verifications share an entity but have disjoint evidence
sets. The bridge memory becomes a discoverable bridge node in the graph
— recall on either cluster will now surface the other through the bridge.

### 4.6 GDPR / Reversibility

Every action ever taken is logged in `governance_action_log` (append-only,
batch-keyed). The `POST /api/governance/rollback/:batch_id` endpoint
walks every applied action in the batch and:

1. Marks the action `status='reverted'`
2. (Future) reverses the memory write — current impl is audit-only;
   physical revert via `before_snapshot` capture is on the roadmap

---

## 5. Schema

### 5.1 Memory.cognitive_layer_role

```sql
ALTER TABLE memories
  ADD COLUMN cognitive_layer_role text NULL
  CHECK (cognitive_layer_role IS NULL OR cognitive_layer_role IN
    ('canonical', 'bridge', 'compression', 'reflection'));
```

### 5.2 governance_action_log

Append-only audit of every proposed/applied/reverted action.

```sql
CREATE TABLE governance_action_log (
  id               uuid PK,
  batch_id         uuid NOT NULL,
  agent_name       text NOT NULL,
  user_id          uuid NULL,
  org_id           uuid NOT NULL,
  target_memory_id uuid NULL,
  action_type      text NOT NULL,     -- enum constrained
  reasoning        text NULL,
  evidence_ids     uuid[] DEFAULT '{}',
  confidence       real NULL,
  status           text DEFAULT 'proposed',  -- enum constrained
  reversible       boolean DEFAULT true,
  before_snapshot  jsonb NULL,        -- cluster_hash + topic + bridge_tag
  after_snapshot   jsonb NULL,
  applied_at       timestamptz NULL,
  reverted_at      timestamptz NULL,
  created_at       timestamptz DEFAULT now(),
  UNIQUE (target_memory_id, action_type, batch_id)
);
```

Action types: `link_update_chain`, `merge_duplicate_cluster`,
`archive_duplicate`, `merge_evidence`, `suppress_noise_cluster`,
`promote_known_risk`, `relationship_candidate`, `canonical_synthesis`,
`bridge_synthesis`, `compression`, `role_assignment`.

### 5.3 governance_agent_state

Per-agent rolling state + token budget + cooldown map.

```sql
CREATE TABLE governance_agent_state (
  agent_name             text PRIMARY KEY,   -- faraday/feynman/turing/governance-cycle
  last_run_at            timestamptz,
  last_completed_at      timestamptz,
  cursor_memory_id       uuid,               -- sliding-window cursor
  config                 jsonb DEFAULT '{}', -- cooldown_map etc
  metrics                jsonb DEFAULT '{}',
  daily_token_budget     int  DEFAULT 1000000,
  tokens_spent_today     int  DEFAULT 0,
  token_budget_reset_at  date DEFAULT CURRENT_DATE,
  circuit_breaker_until  timestamptz,        -- cycle lock + budget-exhausted gate
  updated_at             timestamptz DEFAULT now()
);
```

### 5.4 governance_metric

Daily rollup for the dashboard.

```sql
CREATE TABLE governance_metric (
  agent_name        text,
  org_id            uuid,
  day               date,
  actions_proposed  int DEFAULT 0,
  actions_approved  int DEFAULT 0,
  actions_applied   int DEFAULT 0,
  actions_reverted  int DEFAULT 0,
  actions_rejected  int DEFAULT 0,
  actions_failed    int DEFAULT 0,
  tokens_spent      bigint DEFAULT 0,
  latency_ms_p95    int,
  PRIMARY KEY (agent_name, org_id, day)
);
```

---

## 6. API Surface

All endpoints require `X-HM-Org-Id` header. Frontend reaches them through
`/v1/proxy/*` on the control plane.

| Endpoint | Purpose |
|---|---|
| `POST /api/swarm/resident/cycle` | Manual cycle trigger (idempotent under row-lock) |
| `GET  /api/swarm/resident/agents` | Agent descriptors (Faraday/Feynman/Turing) |
| `POST /api/swarm/resident/agents/:id/run` | Single-agent run |
| `GET  /api/governance/metrics?days=N` | Daily rollup + per-agent state |
| `GET  /api/governance/action-log?status=…&limit=…` | Paged audit |
| `POST /api/governance/actions/:id/approve` | Apply proposal via executor |
| `POST /api/governance/actions/:id/reject` | Mark rejected |
| `POST /api/governance/rollback/:batch_id` | Revert every applied action in batch |
| `GET  /api/connectors/health` | Per-provider Nango health + stale flag |
| `POST /api/cognition/stop` | Runtime kill switch (admin) for legacy cognition-loop |

---

## 7. Token Budget

Each agent has a `daily_token_budget` (default 1M tokens). At cycle start
the breaker checks each agent — if any is over budget the cycle returns
`{status: 'skipped_budget_exhausted', agents_over_budget: [...]}`.

Token accounting:
- **Faraday**: real LLM usage captured from `data.usage.total_tokens` on
  the Groq fetch call, stashed in `globalThis.__faradayLastTokens`, read
  by `runFullCycle` and folded into `tokens_spent_today`.
- **Feynman + Turing**: no direct LLM calls in current implementation —
  fallback estimate `GOV_FALLBACK_TOKENS_PER_RUN=5000` per agent per cycle.
- **Cognitive tools** (canonical/bridge): real usage from
  `cognition-loop._llmCanonicalFact` / `_llmSynthesisBridge` — both surface
  `tokens_used` on the result and tools accumulate on `tokensUsedLifetime`.

Daily reset: `token_budget_reset_at < CURRENT_DATE` triggers an automatic
zero of `tokens_spent_today` at next cycle.

---

## 8. Tuning Knobs (Env)

| Var | Default | Purpose |
|---|---|---|
| `ENABLE_GOVERNANCE_SCHEDULER` | `true` | Master switch for scheduled cycles |
| `GOVERNANCE_INTERVAL_MS` | `1800000` (30m) | Tick cadence — also `14400000` (4h) common for prod |
| `ENABLE_COGNITION_LOOP` | `false` | Legacy loop disabled (governance owns synthesis) |
| `MEMORY_TENANT_STRICT` | `true` | Hard-block Memory/Relationship/SourceMetadata queries without org/user/FK scope |
| `RATE_LIMIT_RPM_PER_ORG` | `120` | Per-org rate limit on `/api/chat` + `/api/recall` |
| `RATE_LIMIT_BURST_X` | `2` | Burst multiplier on token bucket |
| `RATE_LIMIT_BACKEND` | auto | `redis` when `REDIS_HOST` set; falls back to in-memory |
| `SYNTHESIS_MODEL` | `openai/gpt-oss-120b` | Primary LLM for canonical + bridge |
| `SYNTHESIS_FALLBACK_MODEL` | `openai/gpt-oss-20b` | Fallback on primary failure |
| `CANONICAL_CONFIDENCE_FLOOR` | `0.7` | Below this, canonical proposal rejected |
| `CANONICAL_COOLDOWN_HOURS` | `6` | Per-cluster_hash cooldown for canonical |
| `BRIDGE_CONFIDENCE_FLOOR` | `0.7` | Below this, bridge rejected |
| `BRIDGE_COOLDOWN_HOURS` | `12` | Per-cluster_hash cooldown for bridge |
| `COMPRESSION_MIN_MEMBERS` | `3` | Required verifications per topic to fire compression |
| `COMPRESSION_COOLDOWN_HOURS` | `12` | Per-cluster_hash cooldown for compression |
| `GOV_FALLBACK_TOKENS_PER_RUN` | `5000` | Heuristic when LLM doesn't surface usage |
| `CONNECTOR_STALE_MS` | `86400000` (24h) | Stale threshold for `/api/connectors/health` |

---

## 9. Recall Flow

When the user asks HIVEMIND a question, the recall router prefers the
cognitive layer:

```
1. Top-down boost on cognitive_layer_role
     canonical/bridge/compression/reflection get score × multiplier
2. WorkingSet boost on user's active entities/threads/projects
3. Tier-1 thin-index deboost (×0.9)
4. Synthesis evidence chain expansion (insight mode)
5. Bridge stop-phrase guard rejects confabulation
```

A canonical fact with score `7.4` will land above raw evidence at `4.0`
when both match the query. The user sees the distilled answer first,
with evidence-trail in `evidence_used[]`.

---

## 10. Operational Runbook

### 10.1 Trigger a cycle manually

```bash
curl -X POST https://core.hivemind.davinciai.eu:8050/api/swarm/resident/cycle \
  -H 'X-HM-Org-Id: <uuid>' -H 'Authorization: Bearer <key>' -d '{}'
```

Response:
```json
{
  "batch_id": "...",
  "status": "completed",
  "faraday":  { "observations_count": 9 },
  "feynman":  { "observations_count": 3 },
  "turing":   { "observations_count": 12 },
  "proposals_persisted": 14
}
```

### 10.2 Review + approve

```bash
# List pending
curl 'https://.../api/governance/action-log?status=proposed&limit=50' -H ...

# Approve one
curl -X POST 'https://.../api/governance/actions/<id>/approve' -H ...

# Reject
curl -X POST 'https://.../api/governance/actions/<id>/reject' -H ...
```

### 10.3 Rollback a bad batch

```bash
curl -X POST 'https://.../api/governance/rollback/<batch_id>' -H ...
```

### 10.4 Inspect metrics

```bash
curl 'https://.../api/governance/metrics?days=7' -H ... | jq
```

### 10.5 Reset budgets if exhausted

```sql
UPDATE hivemind.governance_agent_state
   SET tokens_spent_today = 0,
       token_budget_reset_at = CURRENT_DATE,
       circuit_breaker_until = NULL
 WHERE agent_name IN ('faraday','feynman','turing');
```

### 10.6 Force-release cycle lock

```sql
UPDATE hivemind.governance_agent_state
   SET circuit_breaker_until = NULL
 WHERE agent_name = 'governance-cycle';
```

---

## 11. Failure Modes & Guards (Karpathy lens)

| Failure | Guard |
|---|---|
| LLM hallucinates fact not in evidence | `isRestatement` trigram check, confidence floor 0.7, evidence-set Jaccard dedup |
| Same cluster re-proposed every tick | `hasOpenProposal` checks recent action_log entries by `cluster_hash` |
| Same cluster re-written after approve | `recordCooldown(6h/12h)` in `governance_agent_state.config.cooldown_map` |
| Two replicas run same cycle | Row-level lock via atomic `INSERT...ON CONFLICT DO UPDATE WHERE expired` |
| Two cycles consume same org budget concurrently | Token budget check is per-agent global, not per-org-cycle — safe under lock |
| Cognition-loop bypass introduces unfollowable writes | Tools route through `_writeSynthMemory` → graph-engine.ingestMemory → entity-co-mention edges still fire |
| Memory writes leak across tenants | Prisma middleware: `MEMORY_TENANT_STRICT=true` blocks `Memory`/`Relationship`/`SourceMetadata` queries without `orgId`/`userId`/`memoryId`/`fromId`/`toId`/`id` scope |
| LLM cost explosion | `daily_token_budget` per agent + `circuit_breaker_until`; per-org rate limit on `/api/chat`+`/api/recall` |
| One bad approve | `POST /api/governance/rollback/:batch_id` reverts every applied action in batch |
| Stale connector token | `GET /api/connectors/health` surfaces age + stale flag |
| Replica failure | Caddy LB `least_conn` + `health_interval 3s` + `max_fails 1` + `lb_try_duration 5s` instant failover |

---

## 12. Production Topology

```
hivemind.davinciai.eu      ──► Vercel CDN ──► SwarmGovernance.jsx
api.hivemind.davinciai.eu  ──► hm-control (control plane)
                                 │  /v1/proxy/* → /api/*
                                 ▼
core.hivemind.davinciai.eu ──► hivemind-caddy
                                 │  least_conn LB
                                 ├──► hm-core   :3001  scheduler=on
                                 └──► hm-core-2 :3011  scheduler=off
                                       │
                                       ├─ Postgres (governance_*, memories, ...)
                                       ├─ Qdrant (vector store)
                                       └─ Redis (rate-limit, queue)
```

Schedule:
- `hm-core` ticks every 30 min, iterates 98 active orgs
- `hm-core-2` is HA standby (scheduler off so cycles don't duplicate)
- Caddy health-checks every 3s; 1 fail = pod out of rotation for 15s

---

## 13. Roadmap

Open work for cognitive-layer maturity:

1. **`canonical_synthesis` emission** — currently 0/cycle in this corpus
   (depends on verification-verdict distribution). Tune Feynman's
   hypothesis confidence so more verifications land at `verdict='likely_true'`.
2. **Physical rollback** — currently `rollback` is audit-only. Capture
   `before_snapshot` on apply, walk it on revert.
3. **Cross-agent challenge mode** — let Turing request Feynman to
   re-explain a hypothesis or Faraday to re-scan a region (currently
   linear chain).
4. **CI eval-gate** — `scripts/eval-gate.mjs` exists but isn't yet wired
   to PR checks. Block merges that drop below baseline.
5. **GDPR retention sweep** — `governance_action_log` grows forever;
   add a 90-day archival job.

---

## 14. References

- `core/src/resident/contract.js` — agent IDs, observation kinds, endpoints
- `core/src/resident/faraday.js` — Explorer
- `core/src/resident/feynman.js` — Analyst
- `core/src/resident/turing.js` — Verifier + tool registry caller
- `core/src/resident/run-manager.js` — `runFullCycle`, row-lock, reflection
- `core/src/resident/graph-action-executor.js` — 5 legacy actions + `_runCognitiveTool`
- `core/src/resident/governance-routes.js` — HTTP API
- `core/src/resident/scheduler.js` — env-gated cron
- `core/src/cognitive-tools/base-tool.js` — shared utilities
- `core/src/cognitive-tools/canonical-synthesis-tool.js`
- `core/src/cognitive-tools/bridge-synthesis-tool.js`
- `core/src/cognitive-tools/compression-tool.js`
- `core/src/cognitive-tools/registry.js`
- `core/src/memory/persisted-retrieval.js` — top-down recall boost
- `core/src/memory/cognition-loop.js` — legacy synthesis (now disabled, helpers reused by tools)
- `core/prisma/migrations/20260527210000_phase1_governance/migration.sql` — schema
- `frontend/Da-vinci/src/components/hivemind/app/pages/SwarmGovernance.jsx` — UI

---

**Last verified:** 2026-05-28 · Eval baseline 15/23 · scheduler tick 98 orgs · cognitive_layer_role rows = 6 395 (post-backfill + ongoing growth).

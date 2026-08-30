# HIVEMIND Ingestion & Relationship Pipeline — Technical README

> Canonical reference for how a memory travels from any entry point (chat, MCP tool,
> connector sync, knowledge-base upload, webhook) through normalization, embedding,
> relationship classification, and graph persistence.
>
> Audience: backend engineers working in `core/src/memory/**`, `core/src/ingestion/**`,
> or `core/src/connectors/**`.

---

## 1. High-Level Flow

```
                ┌──────────────────────────────────────────────────────┐
                │                     ENTRY POINTS                     │
                │                                                      │
                │  Talk-to-HIVE chat        MCP tools (save_memory,    │
                │  (react-agent-v2)         ingest_code, log_decision) │
                │  Connector syncs          KB document upload         │
                │  (Slack/Gmail/GDocs…)     (Docling pipeline)         │
                │  Nango webhooks           memory-tap middleware      │
                └───────────────┬──────────────────────────────────────┘
                                ▼
              ┌─────────────────────────────────────┐
              │  graph-engine.ingestMemory(input)   │   ← CANONICAL GATEWAY
              │  core/src/memory/graph-engine.js    │     every save passes here
              └───────────────┬─────────────────────┘
                              ▼
              ┌─────────────────────────────────────┐
              │  SmartIngestRouter.route(payload)   │
              │  core/src/memory/                   │
              │  smart-ingest-router.js             │
              │                                     │
              │  1. detect source type              │
              │  2. normalize content               │
              │  3. type-specific routing/chunking  │
              │  4. _enrichWithTripleOperator       │
              └───────────────┬─────────────────────┘
                              ▼
              ┌─────────────────────────────────────┐
              │  graph-engine (post-router)         │
              │  • ts:* tag + timestamp stamping    │
              │  • relationship classification      │
              │  • createMemory + source_metadata   │
              │  • fact extraction (max 5/parent)   │
              │  • entity co-mention edges (LLM)    │
              │  • contradiction detection          │
              │  • applyUpdate/Extends/Derives      │
              └───────────────┬─────────────────────┘
                              ▼
              ┌──────────────────┬──────────────────┐
              │   Postgres       │     Qdrant       │
              │   (Prisma,       │     (vectors,    │
              │   memories +     │     per-tenant   │
              │   relationships) │     collections) │
              └──────────────────┴──────────────────┘
```

Async/bulk path (documents, connector batches) additionally runs through the
**BullMQ ingestion pipeline** before reaching the gateway:

```
job → pipeline-orchestrator.process(job)
        EXTRACTING  → extractors/ (pdf, text, url, code, conversation)
        CHUNKING    → text-chunker (sliding window) / ast-chunker (code)
        EMBEDDING   → embedder.js (Mistral primary; vectors normalized to EMBEDDING_DIMENSION)
        INDEXING    → indexer.js (Qdrant upsert) + persistence.js (memoryWriter → graph-engine)
        DONE        → audit log + `memory.ingested` event + PageIndex classification hook
```

---

## 2. The Three Relationship Operators

Every new memory is classified against existing memories into one of three
canonical **triple operators** (plus `Contradicts` from conflict detection):

| Operator | Meaning | Effect on graph |
|---|---|---|
| **`Updates`** | New memory supersedes an old one | Old memory flipped `is_latest=false`; `Updates` edge new→old; version snapshot recorded |
| **`Extends`** | New memory augments an existing one | `Extends` edge created; both stay `is_latest=true` |
| **`Derives`** | New memory synthesizes from multiple sources | `Derives` edges from each source; all stay latest |
| `Contradicts` | Conflicting claims, not reconcilable | `Contradicts` edge; both stay latest; surfaced to UI |

`created` (no relationship) is the default when nothing similar exists.

### 2.1 Alias normalization — `relationship-semantics.js`

All inbound spellings collapse to canonical types via `RELATIONSHIP_ALIASES`:

- `update / updates / supersede(s) / replace(s) / correct(s) / revise(s)` → **Updates**
- `extend(s) / extended / augment(s)` → **Extends**
- `derive(s) / derived / synthesize(s) / synthesis` → **Derives**

`normalizeRelationshipDescriptor(input, context)` is the universal normalizer —
it accepts every field-name variant (`target_id`, `targetId`, `to_id`,
`sourceIds`, `derived_from`, `_derives_from`, …) and returns a canonical
descriptor `{ type, operator, operation, confidence, sourceId, targetId,
sourceIds, claimIds, findingIds, observationIds, …roles }`.

`buildSemanticMetadata(...)` turns that descriptor into the
`semantic_*` metadata keys persisted on every memory
(`semantic_role`, `semantic_relationship`, `semantic_provenance`, …).

### 2.2 Where each operator gets decided (priority order)

1. **Explicit caller relationship** — MCP `hivemind_save_memory` with
   `relationship: "update" + related_to: <id>`; connector `ingestFromEndpoint`
   with a `relationship` param. Maps via `buildRelationship()` in
   `core/src/mcp/hosted-service.js`. Skips all inference.
2. **SmartIngestRouter `_enrichWithTripleOperator`** — semantic pre-flight
   (see §3.3).
3. **RelationshipClassifier fallback** — `relationship-classifier.js`,
   token-similarity + linguistic signals, runs in graph-engine when the router
   produced no relationship.
4. **Contradiction reconciliation** — post-create pass in graph-engine that can
   promote a detected contradiction to `Updates`/`Extends` (see §4.4).

---

## 3. SmartIngestRouter — `core/src/memory/smart-ingest-router.js`

### 3.1 Source-type detection

`_detectSourceType()` reads `source_metadata.source_platform` /
`source_type` / `ingest_type`. Explicit platforms win; with no platform,
`detectContentType()` auto-detects from content (confidence ≥ 0.70 required).

| Detected type | Route | Default `memory_type` | Special handling |
|---|---|---|---|
| `gmail` | `_routeGmail` | `event` | Extract Subject/From/Date, strip headers, carry `thread_id` |
| `claude` | `_routeClaude` | `lesson` | Distill to decision/preference/insight lines |
| `knowledge_base` | `_routeKnowledgeBase` | `fact` | Chunk by strategy (headings, paragraphs, turns, rows, keys, html) |
| `github` | `_routeGithub` | `decision` | passthrough |
| `slack` | `_routeSlack` | `event` | passthrough |
| `chat` | `_routeChat` | `fact` | clean user statements |
| `manual`/other | passthrough | caller-set | — |

### 3.2 Chunking strategies (knowledge base)

`CHUNK_STRATEGY_MAP` selects per detected document type:
`heading_hierarchy`, `paragraph_split`, `turn_pairs` (conversations),
`row_batches` (CSV, header repeated per batch), `key_sections` (JSON/YAML
top-level keys), `article_structure` (HTML headings). Max chunk ~2000 chars.
Multi-chunk docs emit one payload per chunk titled `"<title> (part i/N)"`.

### 3.3 Triple-operator inference — `_enrichWithTripleOperator`

Runs per payload unless the caller set an explicit `relationship`. Searches
top-5 similar latest memories (scoped `user_id` + `org_id` + `project`), then
applies rules **in this order**:

| Rule | Condition | Result |
|---|---|---|
| Thread match | `thread_id` equals an existing memory's thread | **Extends** (conf 0.95, reason `thread_match`) |
| Session match | same `source_session_id`, score > 0.5 | **Updates** (conf 0.9, reason `session_match`) |
| High similarity | top score ≥ **0.88** | **Updates** (reason `high_similarity`) |
| Moderate similarity | top score ≥ **0.65** | **Extends** (reason `moderate_similarity`) |
| Multi-source band | ≥ 2 matches with score in **[0.40, 0.65)** | **Derives** from up to 5 sources (reason `multi_source_synthesis`) |
| Contradiction signal | negation phrases ("no longer", "switched to"…) | `_contradicts_hint` passed to graph-engine |
| None | — | plain `created` |

Content shorter than 30 chars skips inference. Pre-flight failure is non-fatal
(logged, payload passes through unenriched).

> ⚠️ The similarity `score` consumed here can come from FTS `ts_rank` (unbounded),
> token cosine (0–1), or Qdrant cosine (0–1) depending on which search backend
> answered — see Known Issues (M-4).

### 3.4 RelationshipClassifier fallback — `relationship-classifier.js`

Used only when no relationship was set upstream. Detects candidates via
`ConflictDetector`, then:

- ≥2 candidates **and** synthesis language ("based on", "combining",
  "in summary", "therefore"…) → **Derives** (top-3 sources)
- replacement language ("now", "updated", "no longer", "deprecated"…) or
  changed numeric values → **Updates**
- otherwise → **Extends**

---

## 4. Graph-Engine — `core/src/memory/graph-engine.js`

The canonical gateway. Key invariants:

- **Every** save routes through `smartIngestRouter.route()` unless
  `_smart_routed` already set. Opt-outs: `smartIngest:false`,
  `skipSmartRouting:true`, `skip_relationship_classification:true`,
  `skip_contradiction_detection:true`.
- Stamps `ts:YYYY-MM-DD` + `ts:YYYY-MM-DDTHHMMZ` tags and a
  `(YYYY-MM-DDTHH:MMZ)` content suffix on every memory.
- Whole ingest body runs inside a **per-user advisory-lock transaction**
  (`prisma-graph-store.transaction()`, 180s timeout).

### 4.1 Classification resolution

```js
classification = explicit relationship      // _explicitClassification (confidence 1.0)
              || relationshipClassifier.classifyRelationship(...)
effectiveRelationshipType = semanticRelationship?.type || classification.relationship?.type
```

Then dispatch:

| Type | Method | Effect |
|---|---|---|
| Updates | `applyUpdate(newId, targetId)` | target `is_latest=false` + `updated_at` stamp, Updates edge, version snapshot, deprecatedIds |
| Extends | `applyExtends(newId, targetId)` | Extends edge, snapshot |
| Derives | `applyDerivesFromSources(sourceIds, newId)` | Derives edge per source (gated by `deriveThreshold` 0.75) |
| none | `_recordVersionSnapshot(reason:'created')` | version row only |

**Updates destructive gate**: supersede additionally requires confidence ≥ 0.85
**and** ≥1 shared non-common `entity:*` tag with the target — this is the guard
installed after the 2026-05 cascade incident (commit `a490e86`).

### 4.2 Fact extraction

After `createMemory`, the MemoryProcessor (or heuristic fallback) extracts fact
sentences. Filters: ≥20 chars, no trivial/sentiment patterns, no meta-facts
("the user provided…"), not duplicating the parent title. **Max 5 facts per
parent.** Each fact-memory gets:

- `semantic_role: 'claim'`, `Derives` provenance from parent (conf 0.9,
  reason `fact_extraction`)
- a physical **Extends** edge fact → parent (created_by `memory_processor`)

### 4.3 Entity co-mention edges — `_attachEntityCoMentionEdges`

LLM pass (`llama-3.3-70b-versatile`) extracting entities + temporal anchors +
memory_type (multilingual). Persists `entity:<Name>` and `time:*` tags.
Edge cap: **6** with `force_entity_linking`, else **3**. Candidates pre-filtered
by tag overlap. For bulk KB promotion this runs **deferred and lock-free**
(`defer_entity_linking` → `linkEntitiesForMemories`, concurrency 6) — see
Known Issues (H-1).

### 4.4 Contradiction detection + reconciliation

`conflict-detector.detectContradictions` (post-create):

- requires **entity overlap** (≥1 shared `entity:*` tag)
- similarity band **0.65–0.92**, both-side signal required
- strips `ts:*` tags and the `(timestamp)` content suffix before any
  similarity/number-divergence calc
- results capped at 5

Reconciliation decides the edge type:

| Signal in new content | Contradiction type | Edge |
|---|---|---|
| Evolution language ("now", "switched", "no longer"…) | temporal_shift / change / explicit_correction / negation | **Updates** (+ supersede) |
| Additive language ("also", "additionally"…) | any | **Extends** |
| Same memory_type + value divergence, conf ≥ 0.7 | value_divergence | **Updates** |
| otherwise | — | **Contradicts** (both stay latest) |

Edge `created_by`: `turing-reconciliation` (reconciled) or `conflict-detector`.

### 4.5 Derive candidate queue

`_enqueueDeriveCandidates` scans latest memories per ingest and enqueues
derivation jobs for candidates ≥ 0.75 similarity (see Known Issues M-2 for the
unbounded-scan caveat).

---

## 5. Async Pipeline — `core/src/ingestion/`

| File | Role |
|---|---|
| `pipeline-orchestrator.js` | BullMQ stage machine (EXTRACTING → CHUNKING → EMBEDDING → INDEXING → DONE), idempotency cache, audit log, `memory.ingested` event, PageIndex hook |
| `queue.js` | Redis multi-host probe (`REDIS_HOST` + `REDIS_HOST_FALLBACKS`), in-memory fallback queue; validates `user_id`+`org_id` on every payload |
| `extractors/` | per-source extraction (pdf via Docling, text, url, code, conversation) |
| `chunkers/text-chunker.js` | sliding window, overlap 150, min 20 words; `splitConversationTurns` for chats |
| `chunkers/ast-chunker.js` | code chunking on AST boundaries |
| `embedder.js` | Mistral `mistral-embed` primary; vectors normalized (pad/truncate) to `EMBEDDING_DIMENSION`; deterministic-vector last resort |
| `indexer.js` | Qdrant upsert with content-hash point IDs; collection = `org_<orgId>` when `QDRANT_PER_TENANT=true`, else legacy shared collection; calls `persistChunk` → memoryWriter → graph-engine |
| `persistence.js` | memoryWriter: content-hash dedup via `source_metadata.metadata.content_hash`; returns `deduped:true` on hit |
| `audit-logger.js` | per-job ingestion audit rows |

The `relationship` field from job data flows through `indexer` context into
every chunk's `persistChunk` call (see Known Issues P0-2 — this currently
mass-applies one relationship to all chunks).

> ⚠️ `core/src/external/ingestion/` contains a **parallel copy** of this
> pipeline (orchestrator, embedder, indexer, queue). Any fix must be applied to
> **both** trees until they are unified.

---

## 6. Entry-Point Cheat Sheet

| Entry | File | Path into pipeline |
|---|---|---|
| MCP `hivemind_save_memory` | `core/src/mcp/hosted-service.js` | `buildRelationship()` → `engine.ingestMemory` |
| Talk-to-HIVE chat saves | `core/src/agent/react-agent-v2.js` (tool-registry save tools) | `engine.ingestMemory` |
| Connector sync | `core/src/connectors/framework/sync-engine.js` | fetchInitial/Incremental → smart-router → `engine.ingestMemoryTree` |
| Connector endpoint ingest | `core/src/connectors/mcp/service.js` `ingestFromEndpoint` | BullMQ pipeline → indexer → graph-engine |
| KB document upload | `core/src/knowledge/document-first-ingestion.js` | Docling → enterprise chunker → bulk promote → deferred entity linking |
| Nango webhooks | `core/src/webhooks/nango-webhook-handler.js` | provider adapter → sync-engine |
| memory-tap middleware | `core/src/agent/middleware/memory-tap.js` | read-tool results auto-ingest |

---

## 7. Retrieval-Side Operator Logic (not ingestion)

`core/src/memory/operator-layer.js` — `CognitiveOperator`:

- `detectQueryIntent()` → temporal/action/factual/emotional/exploratory/preference
- `computeDynamicWeights()` → blends scorer weights by intent
- `assembleFrame()` → tiered cognitive frame (anchor: fact/preference;
  trajectory: goal/event; modifiers: decision/lesson; connectors: relationship)
  within a token budget
- `maintainCoherence()` → **suggests** `Updates` (sim ≥ 0.85) / `Extends`
  (sim ≥ 0.60) for incoming memories; advisory only, creates no edges

---

## 8. Configuration Reference

| Env / constant | Default | Meaning |
|---|---|---|
| `SIMILARITY_UPDATE_THRESHOLD` | 0.88 | router score → Updates |
| `SIMILARITY_EXTEND_THRESHOLD` | 0.65 | router score → Extends |
| Derives band | [0.40, 0.65) ×2 sources | router → Derives |
| Updates destructive gate | conf ≥ 0.85 + entity overlap | graph-engine supersede |
| `deriveThreshold` | 0.75 | applyDerives edge gate |
| conflict-detector `minSimilarity` | **0.65** (0.75 strict) | DO NOT lower — 0.40 caused the edge-explosion incident |
| conflict-detector band cap | 0.92 / max 5 results | — |
| `EDGE_CAP` (entity co-mention) | 6 forced / 3 default | — |
| `EMBEDDING_DIMENSION` | 1536 | Qdrant collection dim (mistral-embed is natively 1024 — padded) |
| `QDRANT_PER_TENANT` | unset | `true` → `org_<orgId>` collections |
| `ENTITY_LINKER_MODEL` | `llama-3.3-70b-versatile` | entity co-mention LLM |
| Max facts per parent | 5 | fact extraction |
| Advisory-lock txn timeout | 180s | per-user ingest serialization |

---

## 9. Known Issues (production audit 2026-06-11)

Full findings in the audit report (23 confirmed: 4 critical/P0, 7 high/P1,
9 medium/P2, 3 low). Highest-priority, **unfixed at time of writing**:

| ID | Severity | Where | Issue |
|---|---|---|---|
| C-1 | CRITICAL | `prisma-graph-store.js` FTS branch | SQL injection: `project` (and date filters) string-interpolated into `$queryRawUnsafe` |
| C-2 | CRITICAL | `graph-engine.js` Extends dispatch | Null-deref when `effectiveRelationshipType` comes from `semanticRelationship` but `classification.relationship` is null |
| P0-1 | CRITICAL | `embedder.js` | "OpenAI fallback" posts to the Mistral endpoint with the Mistral key — fallback never works; silent deterministic-garbage vectors on Mistral outage |
| P0-2 | CRITICAL | `connectors/mcp/service.js` + `indexer.js` | Caller `relationship` stamped on **every** chunk → mass-supersede of one target (N Updates edges, corrupted version chain) |
| H-1 | HIGH | `linkEntitiesForMemories` | Lock-free concurrent supersede → double/orphaned `is_latest` flips |
| P1-1 | HIGH | `pipeline-orchestrator.js` | `completedByIdempotency` Map unbounded → worker OOM; `this.logger` undefined in PageIndex `.catch` |
| P1-2 | HIGH | `embedder.js` / `indexer.js` | No timeouts/backoff on any external call (Mistral, Qdrant); 429 retry storm |
| M-4 | MEDIUM | router + store | similarity `score` mixes FTS `ts_rank` (unbounded) with cosine (0–1); operator bands meaningless on FTS path |

---

## 10. Operational Runbook Pointers

- Boot check / log tail / memory counts / eval harness: see
  `~/.claude/skills/hivemind-apex/SKILL.md` verification commands.
- `is_latest` cascade repair: `core/scripts/reingest-memories-canonical.mjs --commit`
- Eval gate before prod release: `core/scripts/eval-harness.mjs` (14 golden cases)
- Per-tenant Qdrant migration: `core/scripts/qdrant-per-tenant-backfill.mjs`

---

## 11. Local Cloudflare Workflow Acceptance Runbook

Heavy Knowledge Base uploads use the Cloudflare path only when all three gates
are true: `HIVEMIND_LOCAL_MODE`, `KNOWLEDGE_INGEST_WORKFLOW_ENABLED`, and the
organization-targeted Flagship flag `knowledge_ingest_workflow_v1`. The job
latches `cloudflare_workflow` at admission; a later flag change cannot move an
in-flight job to BullMQ.

Use `scripts/start-production-parity-local-ingestion.ps1` to import only the
production inference, embedding, parser, and AI Gateway policy into the local
Core container. It deliberately preserves local PostgreSQL, Redis, Qdrant,
auth, Queue, Workflow, R2, Flagship, API hosts, and secrets. Never copy an
entire production environment file into local Compose.

Run concurrent files with `scripts/run-local-heavy-ingest-canary.mjs`. A valid
terminal receipt requires all of the following:

- every job is `ready` with ten successful receipts for its current processing
  version;
- persisted segment count equals vector-stored segment count;
- receipt memory count equals the distinct live document citation count;
- forced replay leaves one current projection, while a memory supported by a
  different document remains active;
- each usage metric settles once despite retries;
- a different organization cannot read the job or source;
- filename/content recall returns persisted results with source citations.

R2 source PUTs are deterministic by organization, checksum, and safe filename.
Transient uploads retry a bounded number of times using
`KNOWLEDGE_INGEST_SOURCE_UPLOAD_ATTEMPTS` and
`KNOWLEDGE_INGEST_SOURCE_UPLOAD_TIMEOUT_MS`; bytes never enter Queue messages or
Workflow step results. If admission exhausts retries, record the exact durable
job as failed and replay that identity after the source is retained. Do not
create a replacement job.

Forced projection replacement is commit-after-success: the previous projection
stays live until the successor's memories, citations, entities, and claims are
durable. Reconciliation then detaches obsolete links, preserves memories with
other document support, retires true document orphans, and removes their
semantic points. A vector-cleanup failure blocks terminal success and is
Workflow-retryable.

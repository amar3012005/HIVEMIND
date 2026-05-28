# HIVEMIND — The Cognitive Memory Engine

> A layered memory architecture for organizations. Connectors flow into an
> evidence lake → user-visible memories form on top → a cognitive layer
> compresses, bridges, and canonicalises the long tail without losing
> source truth.

**Status:** Live design — reflects the codebase at commit `a08228d`
(Phase 3 tiered cognition active).
**Audience:** Engineers extending HIVEMIND. Product folk deciding what
layer a new feature belongs in. Customers asking "is this just RAG?"

---

## 0. Why a cognitive memory engine, not a knowledge base

A traditional knowledge base stores documents and retrieves them by
keyword or vector similarity. It does not:

- distinguish between **a thing said** and **a thing concluded**;
- detect contradictions between two sources said at different times;
- compress 50 emails about the same deal into a single canonical fact
  the rest of the system can reason against;
- forget, supersede, or version individual claims as the world changes;
- emit reflections about its own retrieval quality.

HIVEMIND treats memory as a **multi-layer cognitive system** with its
own metabolism. New input enters at the bottom, gets normalised,
embedded, related, contradicted, and finally compressed upward. Queries
descend from the cognitive layer (cheap, dense) and only fall back to
raw evidence when synthesis confidence is low.

Four layers, each with its own write path, read path, and lifecycle.

```
┌────────────────────────────────────────────────────────────────────┐
│ Cognitive Layer                                                    │
│ Canonical facts · Bridges · Compressions · Reflections             │
│ Synthesised, deduplicated, hash-stable. Tiered cadence: 1h/4h/12h. │
├────────────────────────────────────────────────────────────────────┤
│ Memory Layer                                                       │
│ Memory rows: claims, decisions, experiences, summaries.            │
│ Bi-temporal (valid_at, transaction_at). Tag + entity + project     │
│ scoped. Embedded into Qdrant per-tenant. Versioned via Updates     │
│ chains.                                                            │
├────────────────────────────────────────────────────────────────────┤
│ Evidence Layer                                                     │
│ Raw chunks from upstream sources. document_chunks +                │
│ source_metadata FK on every memory. Searchable independently       │
│ when memory text is insufficient (Hop 2 of recall).                │
├────────────────────────────────────────────────────────────────────┤
│ Company Database / Source-of-Truth Connectors                      │
│ Slack, Gmail, Google Docs, Notion, GitHub, Linear, Atlassian,      │
│ Salesforce, uploaded PDFs, browser-extension captures, hyper-room  │
│ decisions. Token vault in Nango. Per-tenant collections in Qdrant. │
└────────────────────────────────────────────────────────────────────┘
```

A piece of information **moves up** the layers as more is learned about
it. It can also move down (deprecated, contradicted, deleted) without
breaking earlier references.

---

## 1. Layer 1 — Company Database / Source Connectors

The bottom layer is everything the company already produces in normal
work. HIVEMIND does not own this data; it indexes and re-projects it.

### 1.1 Connector taxonomy

| Provider | Mode | Auth | Cadence |
|---|---|---|---|
| `slack` | live + history backfill | Slack OAuth (via Nango) | event-driven + 24h sync |
| `gmail` | live + history backfill | Google OAuth (via Nango) | Pub/Sub webhook + 24h sync |
| `google-docs` | full doc + change watch | Google OAuth (via Nango) | webhook + 4h sync |
| `notion` | DB + page + comment ingest | Notion OAuth (via Nango) | webhook + 4h sync |
| `github` | repo + issue + PR + commit | GitHub OAuth | webhook + 4h sync |
| `linear` | issue + comment | Linear OAuth | webhook + 4h sync |
| `atlassian` | Jira + Confluence | Atlassian OAuth | webhook + 4h sync |
| `salesforce` | account + opportunity + activity | Salesforce OAuth | 4h sync |
| `web` | URL crawl + lightpanda render | none | on-demand |
| `upload` | PDF / DOCX / image OCR via Docling | none | sync-on-upload |
| `hyper-rooms` | multi-agent debate transcripts | session | event-driven |
| `browser-extension` | side-panel captures from any web page | session | on-demand |

All OAuth tokens live in **Nango** (self-hosted at
`api.hivemind.davinciai.eu:8042`). HIVEMIND never stores raw provider
tokens. Token refresh, rotation, and revocation all flow through Nango.

### 1.2 Tenancy and scoping at ingest

Every record entering layer 1 carries:

- `user_id` (the human who connected the source);
- `org_id` (the workspace);
- `project_id` (optional — set by Project Switcher in FE);
- `scope` ∈ {personal, project, team, organization};
- `visibility` ∈ {personal, organization} (UI-level filter);
- `access_context` (V2 multi-tier: list of project ids + team ids
  the user has access to).

The `scope` controls whether org-wide cognition (Faraday) is allowed to
see the source. `personal` is hidden from cognition entirely.

### 1.3 Per-tenant vector isolation

Embeddings flow into Qdrant. When the env `QDRANT_PER_TENANT=true` is
set, every org gets its own collection (`org_<orgId>`). Otherwise a
shared legacy collection (`BUNDB AGENT`) is used; this is being migrated
away from. See `core/scripts/qdrant-per-tenant-backfill.mjs`.

### 1.4 Webhooks land at the control plane

```
provider ─→ Nango ─→ control-plane:/v1/proxy/connectors/<provider>/webhook
                       │
                       ▼
                ingestion-pipeline.queue() ─→ Bull or in-mem queue
                       │
                       ▼
                evidence layer (next section)
```

Each webhook handler is responsible for verifying provider signature,
turning the event into a normalised "raw record", and enqueuing it. The
queue dispatcher decides between `chunk-then-embed-then-memorize` for
documents and `direct-memorize` for short events (Slack message, Gmail
thread reply).

---

## 2. Layer 2 — Evidence Layer

The evidence layer is the **forensic record**. Everything memories
later claim must be traceable to a row here. If a memory says "Uwe
proposed 18% recurring revenue on May 22", layer 2 has the raw email
chunk that supports it.

### 2.1 Tables

```
document_chunks          one row per chunked segment of a source doc
  ├ document_id          parent doc (a PDF, a long thread, a Notion page)
  ├ chunk_index          ordinal within doc
  ├ content              raw text, sliding window with 150-tok overlap
  ├ heading              section header inferred at chunk time
  ├ page                 page number for paginated sources
  ├ embedding_id         Qdrant point id (deterministic content-hash)
  ├ source_url
  ├ source_metadata      JSON: thread_ts, from_email, github_sha, …
  └ created_at

source_metadata          one row per memory, foreign key on Memory.id
  ├ memory_id            ← Memory PK
  ├ source_type          slack | gmail | gdocs | notion | … | upload
  ├ source_id            provider-native id (msg_ts, gmail_msg_id, …)
  ├ source_platform      slack | gmail | …
  ├ source_url
  ├ document_id          ← document_chunks.document_id when applicable
  ├ ingest_path          live | history-backfill | retry | manual
  └ raw                  full provider payload (for replay / debugging)

segment_promotions       audit trail when a chunk is promoted into a memory
  ├ chunk_id
  ├ memory_id
  ├ promoted_at
  └ reason               first-time | revision | bridge | compression-input
```

### 2.2 Chunking

`core/src/ingestion/chunkers/text-chunker.js`. Sliding window: target
1000 chars, 150-token overlap, minimum 20 words. PDFs go through
**Docling** (`docling:5001` service) first to extract structured text
including tables and figures. Code goes through tree-sitter
(`code-review-graph` MCP service) to chunk by symbol boundary.

### 2.3 Embedding

Primary: Mistral (`mistral-embed`, 1024 dim). Fallback: OpenAI
(`text-embedding-3-small`, 1536 dim — padded to 1024 via random
projection). Env: `EMBEDDING_DIMENSION` must match the live collection.
Caller in `core/src/ingestion/embedder.js`.

### 2.4 Why a separate evidence layer at all?

Two reasons:

1. **Citation truth.** Memory rows are often LLM-summarised. The exact
   words from the source are stored here so we can quote them back
   verbatim when an agent says "according to Uwe's email…". Without
   this, an agent's claim is uncheckable.
2. **Recall depth.** When Hop 1 (memory-only recall) returns no
   strong match, Hop 2 falls back to chunk-level vector search and
   joins back to the parent document. This catches long-tail facts
   that never got promoted into a memory.

### 2.5 Recall path through evidence

```
query
  ↓
hop1Memory()       Memory table — tag filter + vector + RRF rerank
  ↓ (low signal)
hop2Evidence()     document_chunks vector search → join to memory_id
  ↓ (still low)
hop3Live()         scan provider in real time (Slack history, Gmail
                   thread) without crossing into Memory
```

Each hop has a hard timeout (`HOP1_TIMEOUT_MS=4000`,
`HOP2_TIMEOUT_MS=4000`, `HOP3_TIMEOUT_MS=6000`) so a slow provider
never blocks the response. See `core/src/memory/recall-router.js`.

---

## 3. Layer 3 — Memory Layer

The memory layer is what users see in the **Memories** page and what
the agent operates against by default. Each memory is a single claim,
decision, experience, or summary, with rich tagging, bi-temporal
metadata, and relationship edges to other memories.

### 3.1 Memory row schema (Prisma `Memory` model)

```
id                    uuid PK
user_id               uuid
org_id                uuid
project_id            uuid?         FK to Project (V2 scope)
memory_type           enum          experience | decision | fact |
                                    preference | procedure | synthesis |
                                    summary | conversation
title                 text          short user-facing label
content               text          body — claim or summary text
tags                  text[]        flat tag array; conventions below
importance_score      float         0..1, ranking signal
scope                 enum          personal | project | team |
                                    organization
visibility            enum          personal | organization
project               text?         legacy free-text project (kept for
                                    backwards compat with V1 ingest)
primary_team_id       uuid?         when scope=team
is_latest             bool          false when superseded
deleted_at            timestamptz?
document_date         timestamptz?  "when this fact was true" (event time)
created_at            timestamptz   "when HIVEMIND learned it"
                                    (transaction time)
updated_at            timestamptz
cognitive_layer_role  text?         canonical | bridge | compression |
                                    reflection — set when a row is
                                    produced by the cognitive layer
synthesis_confidence  float?        LLM-reported confidence for synth
synthesis_revision    int?          delta-update version
synthesis_cluster_hash text?        stable hash over (entity_set | topic)
synthesis_evidence_ids uuid[]       member ids when this memory is a
                                    cognitive-layer rollup
```

### 3.2 Tag conventions

Tags drive recall filtering and graph traversal. The ingest pipeline
auto-stamps:

- `entity:<Canonical_Name>` — every recognised proper noun. Names are
  underscored, capitalised. Resolved via `canonical_entities` table.
- `time:<value>` — wall-clock anchors (`time:2026-05-28`,
  `time:14:55`, `time:tuesday`, `time:q2-2026`).
- `ts:<iso>` — exact ingest timestamps. Stamped twice: date-only
  (`ts:2026-05-28`) and minute (`ts:2026-05-28T1455Z`).
- `topic:<word>` — main topic word (heuristic, fallback for cluster
  matching).
- `project:<slug>` — when ingested under a project.
- `filename:<basename>`, `doc-hash:<sha>`, `doc-id:<uuid>` — only on
  PDF/DOCX ingest.
- `from:<email>`, `thread:<ts>` — Gmail.
- `channel:<id>` — Slack.
- `repo:<name>`, `issue:<n>`, `pr:<n>`, `sha:<short>` — GitHub.
- `source:<platform>` — coarse provenance.
- `type:fact`, `type:decision` — duplicated from `memory_type` for
  cheap tag filters.

Hidden / suppressed tags (caller-opt-in via `tags=[...]`):

- `internal-audit` — governance reflection rows. Listed in
  `prisma-graph-store.listMemories` and `persisted-retrieval.recall`
  exclusion lists.
- `room-decision`, `hyper-rooms` — multi-agent debate outputs.

### 3.3 Bi-temporal model

Every memory has two time axes:

- **`document_date` — Event time.** When did the fact happen in the
  world? An email sent 2024-01-04 ingested today has
  `document_date=2024-01-04`.
- **`created_at` — Transaction time.** When did HIVEMIND learn?

Time-travel queries (`?as_of=2024-06-01`) filter by `document_date <=
as_of`. They also include `is_latest=false` rows that were latest at
the historical moment. See `core/src/memory/recall-router.js` for the
exact predicate.

This is what lets the system answer "what did we know about Uwe in
March?" without rewriting history.

### 3.4 The canonical save pipeline

Every memory flowing into the system, regardless of source, runs the
same pipeline. The single entry point is
`graph-engine.ingestMemory(input)`:

```
caller (connector / chat / agent / direct API)
       ↓
graph-engine.ingestMemory(input)
       ↓ if !input._smart_routed
smart-ingest-router.route(input)
   ├ provider-specific normaliser (slack / gmail / gdocs / gemini)
   ├ recall similar memories within window
   ├ infer triple-operator (Updates / Extends / Mentions) over similar
   └ return { parent, children } OR Payload[]
       ↓
graph-engine stamps ts:* + appends (YYYY-MM-DDTHH:MMZ) suffix
       ↓
_buildMemoryRecord → store.createMemory → source_metadata row
       ↓
_attachEntityCoMentionEdges
   - LLM (llama-3.3-70b) extracts entities + temporal anchors
   - persists entity:<Name> + time:<...> tags
   - EDGE_CAP=6 when force_entity_linking, else 3
       ↓
conflict-detector.detectContradictions
   - entity-overlap required
   - minSimilarity 0.65, both-sides-signal required
   - strips ts:* + suffix before numeric divergence calc
   - caps results at 5
       ↓
relationship-classifier (LLM, one-shot)
   - decides Updates (supersede) / Extends / Mentions
   - applyUpdate flips is_latest on older claim
   - applyDerives writes edges for evidence chains
```

Opt-outs (rare and dangerous): `smartIngest: false`,
`skipSmartRouting: true`, `skip_contradiction_detection: true`,
`skip_relationship_classification: true`. Used only in test seed
scripts. Never wire these into production paths.

### 3.5 Relationship edges (graph layer)

```
relationships table
  from_id           uuid → memories.id
  to_id             uuid → memories.id
  type              Updates | Extends | Mentions | Derives | Contradicts
  confidence        float 0..1
  metadata          JSON — source, action_type, suggested_relationship_type
  created_by        free text — turing | csi-turing | entity_co_mention_llm
                                | conflict-detector | …
  created_at
```

`Derives` is the cognitive-layer marker: when canonical/bridge/
compression writes, it draws Derives edges from itself back to each
evidence memory. That lets the UI render "this canonical was built
from these 7 source memories".

`Updates` chains form the version timeline: `A ← Updates ← B ← Updates
← C` means C is the latest, A and B have `is_latest=false`. Reach the
chain via `traverseUpdateChain()`.

### 3.6 Memory ranking signals

Recall ranking blends:

| Signal | Default weight | Source |
|---|---|---|
| similarity | 0.45 | dense vector distance from Qdrant |
| recency | 0.15 | exponential decay on `document_date` |
| importance | 0.10 | `importance_score` column |
| vector | 0.20 | post-RRF vector boost |
| graph | 0.05 | shared-cluster boost (Move 3) |
| policy | 0.05 | scope/access weighting |

`Operator Layer` (`detectQueryIntent` + `computeDynamicWeights`) can
rewrite these per-query: "what did Uwe say last week" boosts recency,
"is this true" boosts policy + importance.

---

## 4. Layer 4 — Cognitive Layer

The cognitive layer is what makes HIVEMIND **a cognitive memory engine
and not a vector DB**. It runs continuously on a tiered schedule (1h,
4h, 12h) and produces four kinds of derived memory:

1. **Canonical facts** — single source of truth on a topic.
2. **Bridges** — explicit causal/temporal/contradiction links between
   two otherwise-disjoint memory clusters.
3. **Compressions** — N source memories collapsed into one lossless
   summary, hash-stable, with append/split/create modes.
4. **Reflections** — internal audit memories produced by the
   governance cycle (Faraday/Feynman/Turing). Hidden from default UI;
   surfaced under `internal-audit` tag.

### 4.1 Governance cycle — Faraday → Feynman → Turing

The cognitive layer is driven by a three-agent reasoning loop. Each
runs in dry-run mode (writes observations, not memories) and produces
input for the next.

```
Faraday  (observer)         Scans recent memories. Emits clusters,
                            semantic trail marks, anomalies, semantic
                            connections. Skip cognitive-layer + audit
                            memories (no self-reflection feedback).

Feynman  (hypothesiser)     Takes Faraday's clusters, generates 1-3
                            hypotheses about each. "X and Y form a
                            real pattern" / "this anomaly is a missed
                            relationship".

Turing   (verifier)         Verifies each hypothesis with second-pass
                            LLM judgement → verdict ∈ {likely_true,
                            inconclusive, unlikely}. Writes
                            governance_action_log rows for each
                            cognitive-tool proposal.
```

Each cycle is keyed by `batch_id`. Runs are persisted in
`op_observations` (dev) and `governance_action_log` (production
proposals).

### 4.2 Tiered cadence

The scheduler ticks every **1h**. Each tick:

```
tickCount % 1  == 0   → canonical_synthesis    (every tick)
tickCount % 4  == 0   → bridge_synthesis       (every 4 ticks)
tickCount % 12 == 0   → compression            (every 12 ticks)
```

Per-tool windows configured via env (with bootstrap-friendly
defaults):

| Tool | `*_WINDOW_HOURS` env | Default | Cooldown |
|---|---|---|---|
| canonical_synthesis | `CANONICAL_WINDOW_HOURS` | 24 | 1h |
| bridge_synthesis | `BRIDGE_WINDOW_HOURS` | 48 | 4h |
| compression | `COMPRESSION_WINDOW_HOURS` | 168 | 12h |

Each tool's `assess()` looks at verifications (canonical, bridge) or
recent memories (compression) WITHIN its window. Cooldowns prevent
re-emitting the same proposal back-to-back. Once stable yield is
proven, tighten windows down to the cadence interval.

### 4.3 Canonical Synthesis Tool

`core/src/cognitive-tools/canonical-synthesis-tool.js`

**Goal:** produce a single canonical fact when multiple verifications
agree about overlapping evidence.

```
assess({ verifications, orgId })
  filter verifications to last CANONICAL_WINDOW_HOURS
  liked = verdict == 'likely_true'  (need >= 2)
  shared_ids = memory ids appearing in >= 2 liked
  topic = top-frequency non-stopword token across liked summaries
  cluster_hash = sha256(topic + sorted(shared_ids))
  cooldown / open-proposal dedup
  → propose { topic, evidence_ids, cluster_hash, confidence }

execute({ … })
  re-check cooldown
  fetch evidence memories
  call cognition-loop._llmCanonicalFact(topic, members)
    primary  : openai/gpt-oss-120b (Groq)
    fallback : openai/gpt-oss-20b
  reject if restatement (≥60% trigram overlap with source)
  reject if llmConfidence < CANONICAL_CONFIDENCE_FLOOR (0.7)
  jaccard dedup against existing canonicals on same topic (>= 0.8)
  → write Memory { memoryType=synthesis, cognitiveLayerRole=canonical }
  → linkDerivesEdges from canonical → each evidence memory
  → recordCooldown(cluster_hash)
```

Output looks like:

> **Canonical fact: ceyda (3 sources)**
> Ceyda Sarioglu is the COO of Davinci AI.
> ← Derives ← src memory 1
> ← Derives ← src memory 2
> ← Derives ← src memory 3

### 4.4 Bridge Synthesis Tool

`core/src/cognitive-tools/bridge-synthesis-tool.js`

**Goal:** find a latent connection between two memory clusters that
never co-occur in a single document.

```
assess({ verifications, orgId })
  liked = window-filtered, verdict=likely_true (need >= 2)
  pull real entity:* tags from referenced memories
    (not from verifications' synthetic content)
  for each pair (i, j) in liked:
    evidence(i) ∩ evidence(j) must be empty (disjoint clusters)
    entities(i) ∩ entities(j) must share >= 1 entity (the bridge)
  best pair by sum of evidence count
  cluster_hash = sha256("bridge:" + sharedEntity + sorted(all_ids))
  → propose { bridge_tag, evidence_ids_a, evidence_ids_b, hash }

execute({ … })
  call cognition-loop._llmSynthesisBridge(tagA, A, tagB, B)
  prompt asks for: bridge_type ∈
      { causal, temporal_arc, contradiction, enabling_gap }
    + bridge_claim (one sentence naming entities + dates)
    + evidence_a/b (uuid + why)
    + actionable_next_step
  reject if bridge_claim < 20 chars (rejects garbage output)
  reject if restatement
  → write Memory { memoryType=synthesis, cognitiveLayerRole=bridge }
  → linkDerivesEdges to both A and B clusters
```

Bridges are the system's way of saying "you didn't know these two
things were related, but they are, here's why".

### 4.5 Compression Tool

`core/src/cognitive-tools/compression-tool.js`

**Goal:** when N memories cluster around the same entity set, collapse
them into one canonical-summary so recall returns dense knowledge
instead of fragments.

```
assess({ orgId })
  fetch memories last COMPRESSION_WINDOW_HOURS (168h default)
    where deleted_at=null AND cognitive_layer_role != 'compression'
  group by entity-set fingerprint:
    entities = tags.filter(t => t.startsWith('entity:')).sort()
    if entities.length < COMPRESSION_MIN_ENTITIES (2): skip
    fp = entities.slice(0,3).join('|')
  reject group if size < COMPRESSION_MIN_MEMBERS (3)
  purity gate: avg pairwise jaccard(entities) >= COMPRESSION_MIN_PURITY (0.5)
    (this is what stopped the legacy "Canonical: null (7 memories)"
     bug that mixed Davinci AI with Hannover Uni acceptance letter)
  cluster_hash = sha256("compression:" + sorted entitySet.join('|'))
  re-compression decision:
    existing = findExistingByHash(hash)
    if not existing                   → mode = 'create'
    elif newOnly.length == 0          → SKIP (no new signal)
    elif overlap_ratio < 0.5          → mode = 'split'
    else                              → mode = 'append'
  → propose { topic, entity_set, evidence_ids, append_ids, mode,
              existing_id, cluster_hash, purity, confidence }

execute({ mode, … })
  fetch members
  content = cognition-loop._buildLosslessSummary(topic, members)
    NO LLM — deterministic concat with separators. Preserves source
    text verbatim. This is why compression is cheap.
  if mode == 'append':
    mergedEvidence = existing.evidence ∪ new
    newContent = lossless summary over union
    UPDATE existing memory: content, title rev N+1, evidence_ids,
                            synthesisRevision++
    linkDerivesEdges from existing → NEW members only
  if mode == 'create' or 'split':
    cognition-loop._writeSummaryMemory({ sourceType: 'compression', … })
    post-write update: cognitiveLayerRole=compression,
                       synthesisClusterHash, synthesisEvidenceIds,
                       synthesisRevision=1
    linkDerivesEdges to all members
  recordCooldown(cluster_hash)
```

### 4.6 Reflection memories

Output of every governance cycle. Hidden from default UI/recall by the
`internal-audit` tag. Tells the operator:

- which agents fired and what they observed;
- what hypotheses Feynman generated;
- which verifications passed/failed;
- how many proposals persisted;
- cycle latency.

Empty-cycle reflections (0 observations, 0 proposals) are now
suppressed at write time — see `run-manager._writeReflectionMemory()`.
Importance is forced to 0.25 so even when surfaced by explicit query,
ranking buries them under real memories.

### 4.7 The graph after one full cycle

```
                      ┌────────────────────────┐
                      │  Canonical: ceyda      │
                      │  (cognitive_layer=     │
                      │   canonical)           │
                      └─────┬──────────────────┘
                            │ Derives
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
  memory: msg-1       memory: msg-2        memory: doc-1
  (Slack, Ceyda)      (Gmail, Ceyda)       (Notion, Ceyda)


                      ┌────────────────────────┐
                      │  Bridge: company||legal│
                      │  (cognitive_layer=     │
                      │   bridge)              │
                      └─────┬──────────────────┘
                            │ Derives
              ┌─────────────┴──────────────┐
              ▼                            ▼
        Cluster A:                    Cluster B:
        decisions about company       legal documents
        ─ memory A1                   ─ memory B1
        ─ memory A2                   ─ memory B2


                      ┌────────────────────────┐
                      │  Canonical: ceyda      │ ← rev 2 (after append)
                      │  evidence: [m1..m5]    │
                      │  (cognitive_layer=     │
                      │   compression)         │
                      └─────┬──────────────────┘
                            │ Derives (new edges added to existing
                            │  canonical when mode=append)
        ┌───────────────────┼────────────────────┐
        ▼                   ▼                    ▼
       m1 m2 m3            m4 m5               (already linked)
```

---

## 5. Read path — how a query crosses all four layers

A query like *"what do we think about GTM with Uwe Berger?"* travels
down:

```
1. Agent receives query.
2. detectQueryIntent → rewriteQuery → expandTemporalQuery.
3. /api/recall:
   3a. recallPersistedMemories scores Memory rows.
       Cognitive-layer rows (canonical/bridge/compression) rank high
       because importance ≥ 0.85.
       Returns 3-5 dense, deduplicated rows.
   3b. crossClusterEntityBoost: any candidate sharing a cluster_hash
       with another candidate gets up to ×1.30 boost (Move 3).
   3c. applyScoreFloor(0.40) → applyMMRDiversity(0.70) →
       collapseClusterDuplicates (canonical + 1 source, hide siblings).
   3d. Drop internal-audit and room-decision tagged rows unless
       caller opted in.
4. recallEnhance:
   4a. hop2Evidence on document_chunks (only fires if inspection
       finds the memory set sparse).
   4b. hop3Live on provider APIs (Slack/Gmail/…) when caller did not
       set include_live=false.
5. Compose injectionText (chain-of-note format with citations).
6. Pass to agent (react-agent-v2 by default) with the agent's
   persona, tools, and conversation history.
```

The reason cognitive-layer memories ranked first is they survived
**three filters** before they ever got written: purity, restatement,
and evidence overlap. They're more reliable than raw memories by
construction.

---

## 6. Write path — how a new fact climbs the layers

A user sends "Ceyda is COO" via chat:

```
1.  /api/chat → react-agent-v2 receives message + recall context.
2.  Agent decides to save → calls hivemind_save_memory tool.
3.  Tool calls graph-engine.ingestMemory.
4.  smart-ingest-router.route:
    a. detect source_type = 'manual'
    b. recall similar memories → finds existing Ceyda memories
    c. infer triple-operator → Extends
    d. return Payload[] with parent set to existing canonical (if any)
5.  graph-engine stamps ts:* tags, appends (YYYY-MM-DDTHH:MMZ).
6.  store.createMemory writes the row + source_metadata.
7.  _attachEntityCoMentionEdges fires:
    - llama-3.3-70b extracts: entity:Ceyda_Sarioglu, entity:Davinci_AI,
      time:tuesday
    - tags appended to the memory.
8.  conflict-detector runs:
    - entity-overlap with existing Ceyda memories ≥ 1
    - similarity 0.78 (above floor 0.65, below ceiling 0.92)
    - both-sides-signal: "Ceyda is COO" + "Ceyda Sarioglu is the COO" ✓
    - no numeric divergence detected
    - applyUpdate fires: older claim `is_latest=false`, new claim
      becomes latest.
9.  relationship-classifier emits an Updates edge from old → new.
10. Memory ready in layer 3.

Async, within next 1h tick:
11. Faraday scans memories, sees Ceyda cluster.
12. Feynman hypothesises "ceyda role at davinci is meaningful".
13. Turing verifies → likely_true with evidence_refs = [new memory, …].
14. canonical_synthesis assess(): finds shared evidence,
    cluster_hash = sha256("ceyda" + sorted_evidence_ids).
15. If hash already canonical → delta-update revision.
    Else → propose new canonical, persist to governance_action_log.
16. Approval (manual via SwarmGovernance UI or auto via
    `?auto_approve=true`) triggers execute() → Memory written into
    layer 4 with cognitiveLayerRole='canonical'.
17. Next recall surfaces the canonical first.
```

That entire chain — connector → evidence → memory → cognition — is the
"cognitive memory engine" loop.

---

## 7. Lifecycle and deletion

| Action | Layer affected | Reversible? |
|---|---|---|
| User edits a memory | Layer 3 (new row + Updates edge) | yes (timeline preserved) |
| User soft-deletes a memory | Layer 3 (`deleted_at` set) | yes (undelete restores) |
| User hard-deletes a memory | Layers 2 + 3 (memory + source_metadata) | no |
| Org admin truncates a cycle | Layer 4 (`governance_action_log`) | no |
| Org admin truncates cognition | Layer 4 (drop canonical/bridge/compression rows + their Derives edges) | no — but evidence in layer 2 remains, next cycle can re-form |
| Tenant offboard | Layers 1-4 (CASCADE on org_id) | no |

The crucial property: **deleting cognitive-layer rows never destroys
source truth.** The bottom three layers remain, and the cognition
loop can rebuild any canonical/bridge/compression from a single
trigger. This is what makes the layer model safe — derived knowledge
is recomputable, original knowledge is preserved.

---

## 8. What this lets you do that a vector DB cannot

| Capability | Vector DB | HIVEMIND |
|---|---|---|
| Find document by similarity | yes | yes (Hop 2 + 3) |
| Quote source verbatim | hard (have to re-fetch chunk) | yes (evidence layer) |
| "What did we know on March 1?" | no | bi-temporal recall |
| Detect contradictions across sources | no | conflict-detector + Updates edge |
| Collapse 50 emails into one fact | no | canonical_synthesis |
| Link two unrelated clusters | no | bridge_synthesis |
| Compress backlog into dense knowledge | no | compression + lossless summary |
| Surface reflections about retrieval quality | no | governance reflections + agent_trust ledger |
| Per-tenant isolation, audit, RBAC | depends on infra | first-class in Memory.scope + RBAC tables |
| Time-travel "memory at any past timestamp" | no | yes |
| Approve/reject cognitive changes before they land | no | governance_action_log workflow |

A vector DB stores text. HIVEMIND stores **what is true, when it was
true, why we believe it, and what we synthesised from it.** That is
the cognitive memory engine.

---

## 9. Roadmap — where each layer is heading

### Evidence layer
- [ ] Provider-native streaming for low-latency live recall (Slack
  socket-mode, Gmail Pub/Sub already on; Notion still pull-based).
- [ ] Docling V2 with table-cell-level chunk granularity.
- [ ] Browser-extension capture format (HTML + DOM snapshot for
  fidelity).

### Memory layer
- [x] Bi-temporal model (event time + transaction time).
- [x] Triple-operator inference at ingest (Updates/Extends/Mentions).
- [x] Project-scoped memories with `Memory.projectId`.
- [ ] Per-memory ACL (RBAC at row level), not just scope.
- [ ] Multi-tier vector index (hot working set + cold archive).

### Cognitive layer
- [x] Tiered cadence (1h / 4h / 12h).
- [x] Entity-set clustering + purity gate (no more `Canonical: null`).
- [x] Hash-stable re-compression with append/split/create.
- [ ] Per-tool model overrides (`CANONICAL_SYNTHESIS_MODEL=gpt-oss-20b`,
      `BRIDGE_SYNTHESIS_MODEL=gpt-oss-120b`).
- [ ] Agent trust scoring wired into `_pick_lead` after 50+ turns of
      observation (display-only today, see `agent_trust` table).
- [ ] User-approvable promotion: when a canonical reaches revision ≥ 3
      with ≥ 5 supporting memories, surface "promote to playbook" CTA.
- [ ] Multi-template debate flows (decision DACI vs free debate)
      already wired via `HyperRoom.template`.

### Cross-layer
- [ ] SCIM v2 provisioning for org + team + project membership.
- [ ] OpenSwarm digital employees with per-employee scoped HIVEMIND API
      keys (in flight, see `employees-service/`).
- [ ] Hyper-rooms: real-time multi-agent debate transcripts becoming
      first-class memories with their own lifecycle.

---

## 10. Key code pointers

| Concern | File |
|---|---|
| Memory schema | `core/prisma/schema.prisma` (`Memory`, `SourceMetadata`, `Relationship`) |
| Save pipeline gateway | `core/src/memory/graph-engine.js` |
| Smart routing | `core/src/memory/smart-ingest-router.js` |
| Entity linking | `core/src/memory/graph-engine.js` → `_attachEntityCoMentionEdges` |
| Conflict detection | `core/src/memory/conflict-detector.js` |
| Relationship classification | `core/src/memory/relationship-classifier.js` |
| Recall (Hop 1) | `core/src/memory/persisted-retrieval.js` → `recallPersistedMemories` |
| Recall router (Hop 1+2+3) | `core/src/memory/recall-router.js` |
| Cognition loop helpers | `core/src/memory/cognition-loop.js` |
| Governance scheduler | `core/src/resident/scheduler.js` |
| Run manager | `core/src/resident/run-manager.js` |
| Faraday | `core/src/resident/faraday.js` |
| Feynman | `core/src/resident/feynman.js` |
| Turing | `core/src/resident/turing.js` |
| Cognitive tool base | `core/src/cognitive-tools/base-tool.js` |
| Canonical synthesis | `core/src/cognitive-tools/canonical-synthesis-tool.js` |
| Bridge synthesis | `core/src/cognitive-tools/bridge-synthesis-tool.js` |
| Compression | `core/src/cognitive-tools/compression-tool.js` |
| Cognitive registry | `core/src/cognitive-tools/registry.js` |
| Governance routes | `core/src/resident/governance-routes.js` |
| SwarmGovernance UI | `frontend/Da-vinci/src/components/hivemind/app/pages/SwarmGovernance.jsx` |
| Memories UI (badges + filter) | `frontend/Da-vinci/src/components/hivemind/app/pages/Memories.jsx` |
| Hyper-rooms orchestrator | `employees-service/src/hivemind_employees/api_hyper_rooms.py` |

---

## 11. Glossary

- **Cluster hash** — sha256 over a normalised entity set + topic. Lets
  re-runs of compression/bridge/canonical recognise an already-known
  cluster instead of producing parallel canonicals.
- **Cooldown** — per-cluster timer that prevents the same proposal
  being re-emitted before a human or auto-approval has acted.
- **Cognitive role** — one of {canonical, bridge, compression,
  reflection}. Stamped on `Memory.cognitive_layer_role` so recall and
  UI can branch on it.
- **Derives edge** — relationship from a cognitive-layer memory back
  to each of its evidence memories. Drawn at execute() time.
- **Drift compaction** — older flow (cognition-loop) that merges
  similar memories within a topic before today's tiered cognitive
  layer existed. Still runs hourly via `cognition-loop.runOnce`.
- **Lossless summary** — deterministic concat-with-separators output.
  No LLM. Used by compression so source text is recoverable.
- **Operator layer** — query-intent classifier that picks dynamic
  recall weights per query.
- **Purity gate** — average pairwise entity jaccard over a candidate
  cluster. < 0.5 → cluster rejected.
- **Tiered cadence** — 1h/4h/12h scheduling of canonical/bridge/
  compression respectively. Governs how often each cognitive tool
  fires.
- **Transaction time vs event time** — when HIVEMIND learned vs when
  the world-fact happened. Both stored, both queryable.

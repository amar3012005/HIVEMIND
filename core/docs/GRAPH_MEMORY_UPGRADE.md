# HIVEMIND Graph Memory — Upgrade Plan vs Supermemory

**Status:** Recon + planning only. No edits yet.
**Owner:** amar
**Last updated:** 2026-05-13

---

## 1. Why this doc exists

The Memory Graph page (`/hivemind/app/graph`) currently renders 292 nodes / 398
edges as a **random-fan-out hairball** — every "document" memory becomes a hub
with 30+ chunk children, and almost no inter-cluster bridges exist. Compare:

| | HIVEMIND today | Supermemory |
|---|---|---|
| Visual structure | Star bursts around document hubs, no semantic groups | Dense **mind-group constellations** with bridges between groups |
| Edges per node | Heavy local (parent→child) | Cross-topic semantic edges form clusters |
| Evolution over time | Edges keep accumulating; nothing collapses or summarizes | Atomic facts get **Updates / Extends / Derives** so groups evolve |
| "Lost in the middle" handling | None | Reranking + recency + thread-scoped retrieval |
| Performance claim | 50k node cap, browser physics tuned by sqrt(N) | "< 300ms at 100B+ tokens / month" |

This doc maps every gap and proposes concrete, ordered upgrades. Implementation
is deferred until plan is signed off.

---

## 2. Supermemory's design principles (what we're benchmarking against)

Extracted from the three URLs the user shared
(`supermemory.ai/docs/concepts/graph-memory`,
`/memory-graph/`,
`/blog/context-memory-guide-ai-systems/`):

### 2.1 Atomic, self-contained nodes (NOT triplet decomposition)

> "Each fact becomes a self-contained node with full context"

Supermemory rejects the SPO (subject-predicate-object) triplet decomposition
that most knowledge graphs use. Every node is a complete, standalone statement.
This is why their nodes group naturally — each one *means* something on its own,
so the graph is built from *meaningful units* not fragments.

### 2.2 Memory types drive node behaviour

| Type | Behaviour |
|---|---|
| **Fact** | Persistent. Updated by newer facts; previous version preserved. |
| **Preference** | Strengthens through repetition (recall count / confirmation). |
| **Episode** | Decays unless re-confirmed or referenced. |

### 2.3 Three relationship types — minimal, semantic

| Type | When created |
|---|---|
| **Updates** | Newer info contradicts existing — `isLatest` flag flips, history kept. |
| **Extends** | Newer info enriches existing — both stay valid, edges add context. |
| **Derives** | Inferred over pattern analysis (multi-source synthesis). |

### 2.4 Automatic evolution mechanisms

- **Time-based forgetting** — episodes decay unless reinforced.
- **Contradiction resolution** — Updates flip isLatest, both versions queryable.
- **Compaction** — long conversations summarized into structured facts.
- **Noise filtering** — non-meaningful content excluded at ingest.

### 2.5 Hybrid retrieval

> "Knowledge graphs track relationships and temporal ordering with explicit
> edges, vector databases find similarity — Supermemory combines both."

Retrieval = vector similarity → graph traversal → rerank by `(query, user,
timestamp, thread)`. Sub-300ms at 100B tokens/mo.

---

## 3. HIVEMIND's current state (verified in code)

### 3.1 Node taxonomy (`prisma/schema.prisma`)

```prisma
enum MemoryType {
  fact          // ← matches Supermemory
  preference    // ← matches
  decision      // ← richer than Supermemory
  lesson
  goal
  event         // ← roughly = Supermemory "episode"
  relationship
}
```

Good news: **enum is richer than Supermemory** (decision/lesson/goal are useful
business categories Supermemory doesn't model).

### 3.2 Edge taxonomy

```prisma
enum RelationshipType {
  Updates
  Extends
  Derives
  Contradicts   // ← we have one Supermemory lacks
}
```

Aliases catalogued in `core/src/memory/relationship-semantics.js`
(updates/supersedes/replace/correct all collapse to `Updates`, etc.). Good.

### 3.3 The big bug: relationships are scored by **bag-of-words cosine**, not embeddings

**`core/src/memory/conflict-detector.js`** lines 15-51:

```js
export function computeTokenSimilarity(left, right) {
  const leftTokens = tokenize(left).map(normalizeToken);   // lowercase + strip
  const rightTokens = tokenize(right).map(normalizeToken);
  // ...counts dot product / magnitude
  return dot / (Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude));
}
```

```js
constructor({ threshold = 0.45 } = {}) {
  // Lowered from 0.92 to 0.45 — the old threshold was so high that
  // only near-exact duplicates qualified as candidates, causing 0 graph edges.
  this.threshold = threshold;
}
```

**This is the root cause of the hairball.** Every memory pair sharing common
English words (the, of, and, with, ...) gets a non-zero score. We're not
measuring *semantic* relatedness, we're measuring *lexical overlap*. Two
unrelated memories that both happen to use the word "project" or "team" 5+
times will get an edge; two semantically identical memories using different
vocabulary will not.

We already store Qdrant vector embeddings for every memory
(`prisma.vector_embeddings`, `core/src/embeddings/mistral.js`). The classifier
never reads them.

### 3.4 No clustering / community structure

```bash
grep -rn "louvain\|leiden\|modularity\|community" core/src
# → 0 results
```

The backend does not compute communities. The `/api/graph` endpoint
(`core/src/server.js:8096`) returns flat `{nodes, edges}` arrays. The frontend
(`MemoryGraph.jsx`) feeds them to `react-force-graph-2d` with only `charge` +
`link` forces:

```js
charge.strength(Math.max(-300, Math.min(-30, -30 - Math.sqrt(n) * 4)));
link.distance(Math.max(30, Math.min(180, 30 + Math.sqrt(n) * 1.5)));
```

No `forceCluster`, no centroid attractors, no community-coloured groups.
That's why nodes spread evenly instead of clumping by topic.

### 3.5 Document hubs cause star-burst topology

When `KnowledgeBase.jsx` uploads a PDF:
1. One **document-summary** memory created (the hub).
2. N **chunk** memories created.
3. Each chunk linked to the document via `Derives` or parent metadata.

Result: every doc = a star burst with 20–100 spokes. Hundreds of bursts × no
inter-burst semantic bridges = exactly the screenshot the user shared.

### 3.6 No node-level "mind group" identity

A node knows its `memoryType`, `tags`, `project`, `userId`. It does **NOT**
know:
- which **semantic cluster** it belongs to (no `clusterId` column)
- which **hub node** anchors that cluster
- its **role** in the cluster (hub / spoke / bridge)

So the frontend has nothing to render groups *with*, even if we wanted to.

### 3.7 No evolution / compaction job

There's a `core/src/resident/` agent layer (Faraday/Feynman/Turing) producing
observations, but there is **no scheduled job** that:
- Merges 5+ similar memories into one consolidated fact
- Promotes a frequently-referenced fact to "high importance"
- Decays / archives orphan episode nodes
- Detects bridge nodes (nodes connecting two distinct clusters)

The graph only grows; nothing collapses.

### 3.8 Retrieval skips the graph

`core/src/memory/persisted-retrieval.js` uses Qdrant vector search + tag filter
+ recency boost. **Traversal of the relationship graph is not part of the
retrieval pipeline**. Edges are decorative.

---

## 4. Gap matrix — Supermemory vs HIVEMIND

| Capability | Supermemory | HIVEMIND today | Gap severity |
|---|---|---|---|
| Atomic self-contained nodes | ✅ | ✅ (already by `Memory.content`) | None |
| Memory type behaviours (fact/pref/episode) | ✅ explicit logic | ⚠ enum exists, no behaviour diff | **MEDIUM** |
| Updates/Extends/Derives | ✅ | ✅ + `Contradicts` | None |
| **Edges via semantic similarity** | ✅ (embeddings) | ❌ **bag-of-words cosine** | **CRITICAL** |
| **Cluster / community structure** | ✅ visual mind groups | ❌ flat graph | **CRITICAL** |
| **Hub / bridge node roles** | ✅ implicit | ❌ no `nodeRole` field | **HIGH** |
| Time-based decay | ⚠ partial (`temporalWeight` in graph endpoint) | ⚠ same | LOW |
| **Compaction job** | ✅ "summarizes conversations into structured facts" | ❌ | **HIGH** |
| Graph traversal in retrieval | ✅ hybrid | ❌ vectors-only | **HIGH** |
| Reranking by (query, user, time, thread) | ✅ | ⚠ partial | MEDIUM |
| Sub-second query at scale | ✅ <300ms | ⚠ depends on node budget | MEDIUM |
| Audit trail / provenance | partial | ✅ full (sourceMetadata, versions) | None — we win |
| Compliance (GDPR/DSR) | unspecified | ✅ deletedAt, retention, scope | None — we win |

**Three "CRITICAL" gaps + four "HIGH" gaps. Net: HIVEMIND has stronger compliance
+ richer enum, weaker graph topology + retrieval.**

---

## 5. Upgrade plan — ordered by leverage

Each phase ships independently. Each is verifiable in isolation. Each leaves
HIVEMIND working if we stop mid-plan.

### Phase 1 — Replace bag-of-words with embeddings (CRITICAL, 2d)

**Root cause fix.** Without this, every later layer is built on noise.

**Files to modify:**

1. `core/src/memory/conflict-detector.js`
   - Add `qdrantClient` to constructor deps.
   - New method `detectCandidatesByEmbedding(newMemory, opts)`:
     1. Get newMemory's vector from `vector_embeddings` (or generate via
        `embeddings/mistral.js` if missing).
     2. Qdrant kNN search top-K=20, filter by same `userId` + `orgId`.
     3. Convert Qdrant score → similarity; keep candidates ≥ 0.65 (raise from
        0.45 because embeddings are way more discriminating).
   - Old `computeTokenSimilarity()` kept as **fallback** when embedding lookup
     fails — never as primary.

2. `core/src/memory/relationship-classifier.js`
   - Accept `useEmbeddings: true` flag (default ON).
   - Pull candidates from new method; pass through existing
     Updates/Extends/Derives decision tree unchanged.

3. `core/prisma/schema.prisma`
   - Add `Relationship.embeddingSimilarity Float?` so we can sort + filter by
     real semantic similarity in the future.

**Verification:**
- Ingest 10 memories about "EU AI Act"; expect 8+ inter-connected edges.
- Ingest 10 memories about "EU AI Act" + 10 about "weekend recipes"; expect
  **zero** edges between the two clusters.

**Why now first:** every clustering / hub / retrieval upgrade below depends on
edges actually meaning something.

---

### Phase 2 — Compute communities at ingest, store `clusterId` (CRITICAL, 1.5d)

Once edges are semantic, run community detection so the graph has *structure*
the frontend can render.

**New file:** `core/src/memory/community-detector.js`

- Run **Leiden** algorithm (lightweight, no external service) over the
  user's full graph nightly + incrementally after each new memory.
- Lib: `graphology` + `graphology-communities-leiden` (pure JS, ~200KB).
- Emits: `{memoryId → clusterId, hubScore, bridgeScore}`.

**Schema:**

```prisma
model Memory {
  // ...existing fields...
  clusterId        String?  @map("cluster_id") @db.VarChar(40)
  clusterRole      String?  @map("cluster_role") @db.VarChar(20)
  //   "hub"      — top 5% by degree centrality within cluster
  //   "bridge"   — top 5% by betweenness centrality across clusters
  //   "spoke"    — everything else
  hubScore         Float?   @default(0) @map("hub_score") @db.Real
  bridgeScore      Float?   @default(0) @map("bridge_score") @db.Real
  clusterUpdatedAt DateTime? @map("cluster_updated_at") @db.Timestamptz(6)
  @@index([clusterId])
  @@index([clusterId, clusterRole])
}

model Cluster {
  id              String    @id @db.VarChar(40)
  userId          String    @map("user_id") @db.Uuid
  orgId           String    @map("org_id") @db.Uuid
  label           String?   // LLM-generated 1-3 word title
  centroidVector  Bytes?    @map("centroid_vector")  // optional pre-computed
  size            Int       @default(0)
  topTags         String[]  @map("top_tags")
  createdAt       DateTime  @default(now()) @map("created_at") @db.Timestamptz(6)
  updatedAt       DateTime  @updatedAt @map("updated_at") @db.Timestamptz(6)
  @@index([userId, updatedAt(sort: Desc)])
  @@map("clusters")
}
```

**Auto-labelling:**
After Leiden produces a cluster of N memories, sample the top 5 by
`importanceScore`, call Haiku 4.5 with a 1-shot prompt: *"Label this cluster in
1–3 words"*. Store in `Cluster.label`. ~$0.0001 per cluster. Worth it.

**Cron:** `cluster-recompute` job runs nightly per active user. Full re-run
~2s for 10k nodes via Leiden.

**Verification:**
- Compute clusters on the user's 292-node graph from screenshot 1; expect
  6–12 clusters of 20–60 nodes each, not 200+ singleton clusters.

---

### Phase 3 — Frontend: cluster-aware layout (CRITICAL, 1.5d)

Make the hairball into mind groups visually. **Same light theme, just structure.**

**File:** `frontend/Da-vinci/src/components/hivemind/app/pages/MemoryGraph.jsx`

1. **Read `clusterId` from API** — already trivial after Phase 2.
2. **Add a `forceCluster` to react-force-graph-2d**:
   - For each cluster, compute centroid coords (e.g. position cluster N at
     `(cos(2πN/K)·R, sin(2πN/K)·R)`).
   - Per-node radial force pulling toward its cluster centroid; strength scales
     with `1 - bridgeScore` (bridge nodes float between centroids).
   - Implementation: `d3-force` `forceX/forceY` initialized per cluster + a
     custom `clusterForce` that re-targets each tick.
3. **Color by cluster**, not just by type. Reuse the existing 8-colour palette
   `USER_COLORS` keyed off `clusterId`.
4. **Hub nodes**: bigger radius + ring outline (`clusterRole === 'hub'`).
   Bridge nodes: small dashed outline (`clusterRole === 'bridge'`).
5. **Cluster label overlay**: render the LLM-generated label at each cluster
   centroid as faint background text.
6. **Cluster filter chip** in top bar: dropdown "All clusters / EU AI Act /
   Customers / Q3 launch / ...". Selecting filters the graph to one cluster
   + its bridge neighbours.

**Light-theme styling stays** — same `bg-[#faf9f4]`, `text-[#0a0a0a]`. Only
structure changes.

**Verification:** Same dataset, same browser, same screen. Hairball → 6-8 clear
constellations with labels.

---

### Phase 4 — Compaction job (HIGH, 2d)

Stops the graph from growing without bound, which is half the visual problem
(too many chunk-level nodes).

**New file:** `core/src/memory/compactor.js`

Triggered nightly per user + on-demand via `/api/memory/compact`.

```
For each cluster with size > 50:
  group memories into "compactable batches" of 10–20 by shared tags
    AND time window (week)
  for each batch:
    call Haiku 4.5: "Summarize these 12 memories into one consolidated fact
                    preserving every entity, number, and date"
    create new memory_type='fact' with summary
    create Updates edges: new_summary → each original
    flip original.isLatest = false
    add Cluster relationship: same clusterId
```

**Knobs in `Cluster` table:**
```prisma
maxNodes        Int       @default(200)  // beyond this, auto-compact
compactionMode  String    @default("auto")  // auto | manual | off
```

**Document hubs:** also collapse — a document's chunks compact into 2–3
"section summaries" instead of 50 raw chunks. Original chunks deleted (or
soft-deleted with `deletedAt`), section summaries get `Updates` edges back.

**Verification:**
- Ingest a 50-page PDF. Before: 50+ chunk nodes. After compaction (nightly):
  3–5 section nodes + 1 document hub. Original chunks soft-deleted.

---

### Phase 5 — Hybrid retrieval (HIGH, 1.5d)

Make the graph part of recall, not decoration.

**File:** `core/src/memory/persisted-retrieval.js`

Current flow: query → embed → Qdrant kNN → tag filter → recency boost → top-K.

New flow (hybrid):
1. Same Qdrant kNN → top-30 candidates.
2. For each candidate, **expand 1 hop along Extends + Derives edges** (skip
   Contradicts unless explicitly requested).
3. Score every node in the expanded set with:
   ```
   score = α·vectorSim + β·edgeConfidence + γ·temporalWeight
         + δ·hubScore + ε·thread_match
   ```
   Default weights: `α=0.45, β=0.20, γ=0.15, δ=0.10, ε=0.10`.
4. Return top-K with provenance: which source memory, which edges traversed,
   which cluster.

**Why hubs help:** the hub of a cluster usually IS the best representative.
Boosting hubScore in retrieval ≈ Supermemory's "self-contained node" effect.

**Verification:** Recall query "EU AI Act deadlines" should now return the
cluster's hub + 2-3 most-cited related facts, not 5 random chunks that
happened to contain the word "Act".

---

### Phase 6 — Memory type behaviour differentiation (MEDIUM, 1d)

Right now `MemoryType` is mostly a label. Make it drive behaviour like
Supermemory does.

**File:** `core/src/memory/strength-updater.js` (new) + edits to
`memory-processor.js`

| Type | Behaviour change |
|---|---|
| `fact` | Default. Updated by newer fact → Updates edge, prior isLatest=false. |
| `preference` | Recall count ≥ 3 → bump `strength` by 0.1 per hit (capped 1.0). |
| `event` | After 90 days unrecalled, soft-archive (deletedAt set, `archived_at` separate). |
| `decision` | Immutable once `Updates`-d; original kept queryable forever. |
| `goal` | Has `target_date` field; if past + no Updates edge → flag for review. |

Cron `memory-decay` runs daily. Free DB cleanup + matches Supermemory's "time-
based forgetting".

---

### Phase 7 — Performance: relationship table cleanup + indexes (MEDIUM, 0.5d)

Currently `/api/graph` does:
- 1 query for high-value nodes
- 2 parallel queries for relationships (priority + bulk)
- 1 query for connected nodes
- 1 query for recent nodes
- 1 query for resident observations
- 1 count query

That's 6+ round trips. Combine into a single materialized view per
`(userId, clusterId)` updated when cluster recompute runs.

```sql
CREATE MATERIALIZED VIEW hivemind.memory_graph_snapshot AS
SELECT
  m.id, m.user_id, m.org_id, m.cluster_id, m.cluster_role,
  m.title, m.content, m.memory_type, m.tags, m.importance_score,
  m.strength, m.recall_count, m.updated_at, m.hub_score, m.bridge_score
FROM hivemind.memories m
WHERE m.deleted_at IS NULL;

CREATE INDEX idx_graph_snapshot_user_cluster ON hivemind.memory_graph_snapshot(user_id, cluster_id);
```

Refreshed concurrently via `REFRESH MATERIALIZED VIEW CONCURRENTLY` after each
cluster recompute run. Graph endpoint reads from view → 1 query, <50ms even
at 50k nodes.

---

### Phase 8 — Frontend cluster sidebar (POLISH, 1d)

Once clusters exist, the right rail of `MemoryGraph.jsx` becomes useful.

Sidebar shows:
- Cluster list (label + size + last activity)
- Click cluster → camera flies to centroid + filters non-cluster nodes to 15% opacity
- Cluster detail panel: top-5 memories by `hubScore`, top tags, "explain this
  cluster" button (one-shot Haiku summary).

Replaces today's flat node-detail panel which shows raw fields only.

---

## 6. Total effort + sequencing

```
Phase 1  CRITICAL  semantic edges via embeddings        2.0d  ────────┐
Phase 2  CRITICAL  Leiden clustering + cluster table    1.5d  ──┐     │
Phase 3  CRITICAL  cluster-aware FE layout              1.5d  ──│──┐  │
Phase 4  HIGH      compaction job                       2.0d  ──│──│──┘
Phase 5  HIGH      hybrid graph-aware retrieval         1.5d  ──┘  │
Phase 6  MEDIUM    memory type behaviour                1.0d        │
Phase 7  MEDIUM    materialized view + indexes          0.5d        │
Phase 8  POLISH    cluster sidebar                      1.0d  ──────┘
                                                        ----
TOTAL                                                  11.0d
```

**Minimum viable upgrade** = Phases 1+2+3 = **5 days**. After that the user
will see structured mind groups in the screenshot.

**Full robustness** = all 8 phases = **11 days**.

---

## 7. Backend efficiency assessment

User asked: *"is the backend efficient enough for robust graph structures?"*

| Check | Status | Notes |
|---|---|---|
| Indexed FK relationships table | ✅ | `(fromId, toId, type)` unique + 4 indexes |
| Embeddings stored once per memory | ✅ | `vector_embeddings` table |
| Qdrant available for kNN | ✅ | Already in stack |
| Soft-delete via `deletedAt` | ✅ | Compliant |
| Bi-temporal (`bi-temporal.js`) | ✅ exists | Not yet exposed in graph endpoint |
| Cascading deletes work | ✅ | Just fixed in another PR |
| Endpoint has scope/limit/project filters | ✅ | Already layered |
| Single-query graph fetch | ❌ | 6 round trips today — Phase 7 fixes |
| Edges store provenance | ✅ | `inferenceModel`, `inferencePromptHash`, `createdBy` |
| Relationships uses real semantics | ❌ | Phase 1 fixes |
| Cluster column / role | ❌ | Phase 2 adds |
| Hub / bridge scoring | ❌ | Phase 2 adds |
| Compaction job | ❌ | Phase 4 adds |
| Graph-aware retrieval | ❌ | Phase 5 adds |
| MV / cache layer for read path | ❌ | Phase 7 adds |

**Verdict:** **Schema is solid, behaviour layer is thin.** Postgres + Qdrant +
asyncpg + Prisma can absolutely sustain 10x current scale. The bottleneck is
*missing logic*, not *missing capacity*. All 8 phases add code only; no
infrastructure changes.

---

## 8. What we do NOT change

To keep risk down + match user's "keep current UI theme" constraint:

- **No dark mode.** Light theme stays exactly as today.
- **No new UI framework.** `react-force-graph-2d` + Tailwind only.
- **No Neo4j / new database.** Postgres + AGE remains canonical store.
- **No removing existing features.** PageIndex, Memory Map, layer filters all
  stay.
- **No breaking API change.** `/api/graph` keeps current shape; new fields
  (`clusterId`, `clusterRole`, `hubScore`) are additive.
- **No removing `Contradicts` edge type.** We keep our 4-type taxonomy even
  though Supermemory only has 3.

---

## 9. Open questions before implementation

1. **Cluster recompute cadence.** Real-time (per ingest) vs nightly batch?
   Real-time is more responsive but burns compute; nightly is fine for v1.
2. **Auto-compact threshold.** 50 nodes per cluster default — too aggressive?
3. **Cluster label provider.** Haiku 4.5 vs Groq compound? Haiku is more
   expensive but better at 1-shot summarization.
4. **Bi-temporal exposure.** Should graph endpoint return time-travel snapshots
   (graph as of timestamp T)? Engine supports it — UI doesn't yet.
5. **Multi-user clusters in team scope.** If org_admin views `scope=all`, do we
   merge personal clusters or keep them separate per user?

These are answered before/during Phase 1 — none block planning.

---

## 10. Recommendation

Ship **Phases 1 + 2 + 3** first (5 days). Reload `/hivemind/app/graph` and
visually compare to the Supermemory screenshot. That alone closes the most
visible perception gap.

Then Phase 5 (hybrid retrieval) — this is what makes HIVEMIND *better at its
job* not just better looking.

Phases 4, 6, 7, 8 are quality + scale upgrades; they can land sequentially or
in parallel since their files don't overlap.

After all 8 phases HIVEMIND offers:

- ✅ Atomic self-contained nodes (had this)
- ✅ Memory-type behaviour (Phase 6)
- ✅ 4 edge types — one MORE than Supermemory (`Contradicts`)
- ✅ Semantic edges via embeddings (Phase 1)
- ✅ Cluster + hub + bridge structure (Phase 2)
- ✅ Auto-compaction + decay (Phase 4 + 6)
- ✅ Hybrid graph+vector retrieval (Phase 5)
- ✅ Sub-100ms graph reads via MV (Phase 7)
- ✅ Visual mind groups (Phase 3)
- ✅ Full audit + DSR + GDPR (already had — Supermemory doesn't)
- ✅ EU sovereign hosting (already had — Supermemory doesn't)

Position: **HIVEMIND = Supermemory + enterprise compliance + EU sovereignty.**

---

**Sign-off needed before any code changes. No edits made yet.**

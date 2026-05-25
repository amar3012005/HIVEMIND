# HIVEMIND Cognition Layer

The cognition layer is what turns HIVEMIND from a memory store into a
**cognitive evolving memory engine**. It converts raw event/fact memories
into compact, falsifiable, lifecycle-tracked **synthesis memories** that
get re-ranked, reaffirmed, extended, or superseded over time as new
evidence arrives.

This document covers everything from first principles: what the loop is,
what memories it produces, how they survive and evolve, how retrieval
prefers them, and what state lives where.

---

## 1. Mental model — three memory tiers

HIVEMIND stores three logical memory tiers:

| Tier | Examples | Lifecycle |
|------|----------|-----------|
| **Raw evidence** | Slack message, Gmail thread, decision log, file chunk, user fact | append-only, soft-deletable, immutable claim |
| **Synthesis** | Canonical fact ("Amar founded DaVinci AI"), Synthesis bridge ("Uwe ↔ Davinci AI offer") | versioned, re-evaluated each tick, supersedable |
| **Cluster index** | Operational metadata per cluster: dirty count, recall count, latest synthesis pointer | mutable, single row per (org, user, cluster_hash) |

Raw memories are the **evidence base**. Synthesis memories are the
**compressed conclusions** the agent reads first during recall. Cluster
index is the **scheduler oracle** for what to synthesize next.

---

## 2. What the cognition loop does

Pseudocode:

```
every cognition tick (per org, periodic + event-driven):

  1. fetch dirty clusters from cluster_index           (Move 1, fast)
     fallback: discover new clusters via tag-intersection scan
              of recent raw memories
  2. for each cluster (cluster_hash = sha256(sorted_tag_pair + top_5_entities)):
       evidence = raw memories matching cluster's tags + time window
       existing = cluster_index.latest_synthesis_id

       if existing AND new_evidence_count > 0:
         LLM picks: REAFFIRM | EXTEND | CONTRADICT | IRRELEVANT
         apply delta path (Phase 2)
       else:
         LLM generates fresh synthesis (Phase 1)
         emit canonical-fact OR synthesis-bridge

       inherit entity:/project:/person:/time:/topic: tags from evidence
       upsert cluster_index row, reset dirty_count

  3. record metrics: tokens, cost, decisions made
```

The loop is **idempotent + bounded**. Same cluster + same evidence + same
LLM seed = same output. Cooldown 6h per cluster prevents thrash.

---

## 3. Memory schema for cognition

`memories` table gains these columns (`prisma/schema.prisma` Memory model):

| Column | Purpose |
|--------|---------|
| `synthesis_confidence` Decimal(3,2) | Current confidence, 0.0-0.98 |
| `synthesis_cluster_hash` varchar(64) | Stable cluster identity |
| `synthesis_revision` Int | 1 on fresh, increments each REAFFIRM/EXTEND |
| `synthesis_evidence_ids` UUID[] | Top-20 supporting memory IDs (hot tail) |

`cluster_index` is a separate table:

```sql
cluster_index (
  organization_id, user_id, cluster_hash,
  cluster_type           text     -- 'canonical-fact' | 'synthesis-bridge'
  entity_keys            text[]   -- inherited or LLM-extracted entities
  top_tags               text[]   -- substantive tags ('topic:*', etc.)
  evidence_count         int
  dirty_count            int      -- bumped when new evidence found
  latest_synthesis_id    uuid     -- → memories.id
  latest_revision        int
  latest_confidence      decimal(3,2)
  last_tick_at           timestamptz
  last_recall_at         timestamptz
  recall_count_30d       int
)
```

UNIQUE constraint on (organization_id, user_id, cluster_hash) makes
upsert atomic.

---

## 4. Phase 1 — Fresh synthesis (canonical-fact + synthesis-bridge)

Two prompt modes, picked by router:

### canonical-fact
"This cluster has ≥3 raw memories asserting variations of the same
claim. Generate the **single most defensible falsifiable statement**
the evidence supports, plus a confidence in [0,1]."

Example output:
> claim: "Amar Sai Gadde is the founder of DaVinci AI."
> confidence: 0.85
> evidence_ids: [78 source memory UUIDs]

### synthesis-bridge
"This cluster crosses 2 distinct entity tag-pairs. Generate the **bridge
fact** that explains how they connect."

Example output:
> claim: "Uwe Berger (B&B agency CEO) offered Amar €200K for 50% of
> DaVinci AI, citing Hannover market access as the strategic value."
> confidence: 0.80
> evidence_ids: [from both clusters' raw memories]

Both modes write through `engine.ingestMemory` so the full canonical
pipeline runs (smart-router, conflict-detector, post-ingest hooks).

**Key files:**
- `core/src/memory/cognition-loop.js` — orchestrator
- `core/src/memory/persisted-retrieval.js` — recall + boost
- prompts inline in cognition-loop.js (gpt-oss-120b primary, 20b fallback)

---

## 5. Phase 2 — Incremental revision

When a cluster already has a synthesis AND new evidence arrives, regenerating
from scratch wastes cost + loses lineage. Phase 2 delta-update path:

```
LLM input: prior_claim + prior_confidence + new_evidence_ids[]
LLM output: { decision, new_claim?, confidence, evidence_to_add }

REAFFIRM    → bump confidence + revision, append evidence_ids
EXTEND      → emit NEW memory via Extends edge, demote prior isLatest=false
CONTRADICT  → emit NEW memory via Updates edge, supersede prior (reset rev=1)
IRRELEVANT  → no-op, log metric
```

### Confidence ladder (per-revision cap)
| Revision | Max confidence |
|----------|---------------|
| 1        | 0.85          |
| 2        | 0.90          |
| 3        | 0.94          |
| 4+       | 0.98          |

CONTRADICT resets to revision=1 → confidence clamps to 0.85 max. Reaffirms
beyond rev 4 keep adding small ε but cap at 0.98 (never claim certainty).

### Why caps matter
Without caps, 50 Slack messages saying "Amar is CEO" → confidence drifts
to 0.999. The cap forces the system to model **belief stability** not
**echo-chamber compounding**.

---

## 6. Phase 3 — Enterprise-scale primitives

Three changes that hardened the loop from "smart research system" to
"durable memory substrate":

### 6.1 `cluster_index` table — scheduler oracle
Before: every tick rebuilt tag-buckets by scanning raw memories. O(N) per
tick where N = recent memory count. 10s+ at 100k memories.

After: `cluster_index.dirty_count` bumped at tick discovery; next tick
pulls top-50 dirty clusters directly (`getDirtyClusters`). O(K) where K =
clusters touched.

Effect: tick latency 10s → 200ms.

Module: `core/src/memory/cluster-index.js`
```js
class ClusterIndex {
  bumpDirty({ organizationId, userId, clusterHash, by = 1 })
  upsertOnSynthesis({ ...full state, resets dirty_count })
  getDirtyClusters({ organizationId, minDirty = 3, limit = 50 })
  getClustersByEntityOverlap({ organizationId, entityKeys, ... })
  recordRecall({ clusterHashes })    // bumps recall_count_30d on every recall
}
```

### 6.2 Revision semantics — single active synthesis per cluster
EXTEND used to keep prior + new revision BOTH `isLatest=true`. Recall
returned both. Agent paraphrased the same idea twice → context budget
wasted.

After: EXTEND immediately flips prior revision `isLatest=false`. Extends
edge preserved for time-travel queries. Recall sees only latest.

Also added: synthesisEvidenceIds capped at 20 (most recent), with
`evidence_count_total` in `source_metadata.metadata` for audit. Hot
recall payload stays compact; lineage stays auditable.

### 6.3 Cross-cluster shared-entity boost
The Uwe-across-3-clusters problem:
- Cluster A: `entity:Uwe + entity:Davinci`
- Cluster B: `entity:Uwe + entity:S60`
- Cluster C: `entity:Davinci + entity:Hannover`

Recall on "what should Amar do about Uwe's offer" returns A but misses
B+C without help. Phase 3 fix lives in recall, not synthesis:

```js
// persisted-retrieval.js — crossClusterEntityBoost(memories, { clusterIndex, orgId })
//
// Post-RRF, pre-slice. For each candidate memory carrying a
// synthesis_cluster_hash, count how many OTHER clusters in the same
// candidate set share at least one entity. Boost score:
//   boost = 1 + min(0.30, 0.10 * overlap_count)
//         + (high_conf_neighbor ? 0.05 : 0)        // cap ×1.35
```

No new LLM calls. No new memories. Just smarter ranking. Wired into
`RecallRouter.recall` after `reciprocalRankFusionMemories`.

Recall router also fires `clusterIndex.recordRecall(uniq cluster_hashes)`
via `setImmediate` — async metric write, never blocks response.

---

## 7. Entity-tag inheritance (latest addition)

The entity-co-mention LLM (in `graph-engine._attachEntityCoMentionEdges`)
runs on every memory write. It's good at extracting proper-noun entities
from short conversational content. It's **bad at synthesis content** —
dense abstract prose like "DaVinci AI is a voice-AI startup" frequently
returns `entities=[]`.

Result: synthesis memories carried 10-25 tags but ZERO `entity:*` tags.
`cluster_index.entity_keys` couldn't populate. `crossClusterEntityBoost`
couldn't match across clusters.

**Fix**: synthesis IS derivative. Its entities = union of evidence
entities. After every synthesis write (CREATE / REAFFIRM / EXTEND /
CONTRADICT), fetch up to 20 evidence memories, union their `entity:*` /
`project:*` / `person:*` / `time:*` / `topic:*` tags, merge onto
the synthesis row.

```js
// cognition-loop.js (4 sites: fresh-write + 3 delta paths)
const evidenceMems = await prisma.memory.findMany({
  where: { id: { in: evidenceIds.slice(0, 20) } },
  select: { tags: true },
});
const INHERITED_PREFIXES = ['entity:', 'project:', 'person:', 'time:', 'topic:'];
const inherited = new Set();
for (const em of evidenceMems) {
  for (const t of (em.tags || [])) {
    if (typeof t === 'string' && INHERITED_PREFIXES.some(p => t.startsWith(p))) {
      inherited.add(t);
    }
  }
}
// merge with existing synthesis tags → prisma.memory.update
```

Cheaper than LLM. Deterministic. Idempotent. Backfill script
`cluster-index-backfill.mjs --commit` runs the same logic over historical
synthesis rows.

---

## 8. Recall flow — how synthesis gets surfaced

Path for any chat / MCP / agent recall:

```
user query
  → hivemind_recall tool (in agent's tool-registry)
  → RecallRouter.recall(query, opts, ctx)
    ├── HOP 1: persistedRetrieval (lexical FTS + vector + RRF)
    ├── HOP 2: evidence-segment expansion (event-driven from tags)
    ├── HOP 3: live workspace fan-out (event-driven from source_platform)
    ↓
  → reciprocalRankFusionMemories(merge)
  → crossClusterEntityBoost(reweight via cluster_index)
  → setImmediate(clusterIndex.recordRecall(seen_hashes))
  → top-15 slice
  → return { memories, evidence, live, trace }
```

Source-type multipliers (applied in `_synthesis_boosted` pass before
RRF):
- `canonical-fact` → ×1.35
- `synthesis-bridge` → ×1.50

Revision multiplier (applied after `_synthesis_boosted`):
- `×(1.0 + 0.05 × min(5, revision - 1))`
- rev 1 = ×1.00, rev 5 = ×1.20

Cross-cluster boost (Phase 3, post-RRF):
- `×(1 + min(0.30, 0.10 × overlap_count) + (high_conf_neighbor ? 0.05 : 0))`
- Caps ×1.35

Composite: canonical-fact at rev 4 with 3 overlapping neighbors and 1
high-conf neighbor = ×1.35 × 1.15 × 1.35 = **×2.10 boost vs raw**. Mature
clusters with cross-talk dominate recall, as designed.

---

## 9. Files map

| Path | Role |
|------|------|
| `core/src/memory/cognition-loop.js` | Tick orchestrator, fresh + delta paths, entity inheritance |
| `core/src/memory/cluster-index.js` | ClusterIndex module (Move 1) |
| `core/src/memory/persisted-retrieval.js` | Recall + RRF + crossClusterEntityBoost (Move 3) |
| `core/src/memory/recall-router.js` | HOP orchestrator, wires clusterIndex |
| `core/src/memory/prisma-graph-store.js` | mapMemoryRecord (must include synthesis_* fields) |
| `core/src/memory/graph-engine.js` | _attachEntityCoMentionEdges, called on every ingest |
| `core/src/memory/smart-ingest-router.js` | _routeSalesforce / _routeGmail / ..., synth-aware preprocessing |
| `core/scripts/cluster-index-backfill.mjs` | One-shot historical backfill + entity inheritance pre-pass |
| `core/prisma/schema.prisma` | Memory + ClusterIndex models |
| `core/prisma/migrations/<ts>_cluster_index/` | Migration creating cluster_index table |

---

## 10. Operational commands

### Inspect cluster index health
```sql
-- Coverage
SELECT cluster_type,
       count(*) AS rows,
       count(*) FILTER (WHERE array_length(entity_keys,1) > 0) AS with_entities,
       avg(array_length(entity_keys,1)) FILTER (WHERE array_length(entity_keys,1) > 0)::numeric(4,1) AS avg_entities,
       sum(dirty_count) AS total_dirty,
       sum(recall_count_30d) AS recalls_30d
FROM hivemind.cluster_index
GROUP BY cluster_type;
```

### Run backfill (idempotent)
```bash
# Inside hm-core container:
docker exec hm-core node /app/scripts/cluster-index-backfill.mjs            # dry-run
docker exec hm-core node /app/scripts/cluster-index-backfill.mjs --commit   # write
```

### Force a cognition tick (manual)
Cognition runs via `SchedulerService` on intervals. To force-tick:
```bash
# TODO: expose POST /api/cognition/run endpoint (Phase 4)
# Workaround for now: restart container, scheduler fires immediately
ssh myserver "docker restart hm-core"
```

### Inspect recent synthesis decisions
```bash
ssh myserver "docker logs hm-core --since 60m 2>&1 | \
  grep -iE 'cognition-loop.*(EXTEND|REAFFIRM|CONTRADICT|emit|inherited)' | tail -30"
```

### Verify Move 2 EXTEND demotion
Look for log line:
```
[cognition-loop] EXTEND: demoted prior <id> isLatest=false (rev N → N+1)
```

### Verify Move 3 cross-cluster boost
Run a chat query that spans clusters. After response:
```sql
SELECT cluster_type, sum(recall_count_30d) AS recalls, max(last_recall_at)
FROM hivemind.cluster_index GROUP BY cluster_type;
```
`recall_count_30d` should increment.

---

## 11. Confidence + decision invariants

These MUST hold or the system gets less trustworthy over time:

1. **No revision ever lands with confidence > revision_cap.** Enforced
   in `_capConfidence()`.
2. **EXTEND demotes prior to isLatest=false.** Enforced inline in
   delta path.
3. **CONTRADICT resets revision to 1.** Fresh claim, fresh cap.
4. **IRRELEVANT decisions never write anything.** Just logged.
5. **synthesis_evidence_ids capped at 20.** Total stored in
   source_metadata.metadata.evidence_count_total.
6. **Entity inheritance is best-effort + non-blocking.** If LLM
   evidence lookup fails, synthesis still lands; entity_keys just stays
   sparse until next backfill.
7. **mapMemoryRecord MUST surface synthesis_*.** If you ever refactor
   prisma-graph-store, ensure all 4 synthesis fields survive the map.
   Phase 3 was dead-on-arrival for 24 hours because of this.

---

## 12. Known gaps + roadmap

| # | Gap | Impact | Effort | Priority |
|---|-----|--------|--------|----------|
| 1 | Raw memory entity coverage 25% (fact/summary) | Sparse cluster_index.entity_keys | 1 day (re-LLM untagged top-K) | medium |
| 2 | No bulk-ingest dirty_count suppression | 1000-cluster simultaneous fire after Salesforce bulk sync | 4 hours | medium |
| 3 | T1 event-driven enqueue threshold (5) not tuned | Cold mature clusters never tick | 2 hours (use log(dirty)+log(evidence_count)) | low |
| 4 | T3 nightly "re-eval ALL" not gated | Cost unbounded at 100+ orgs | 2 hours (gate on last_tick > 30d) | medium |
| 5 | GDPR cascade on memory delete | Synthesis still references deleted evidence_id | 4 hours | **high** (enterprise blocker) |
| 6 | No POST /api/cognition/run (Tier 4 on-demand) | Cannot force tick from FE / agent | 2 hours | low |
| 7 | Logistic confidence ladder not yet | Steep early gains, flat late — see Phase 2 notes | 1 hour | low |
| 8 | Meta-bridges (Cluster-of-Clusters) | Cross-cluster boost handles 80% of value; meta-bridges for hard cases only | 1 day | defer |

---

## 13. History (commit trail)

| Commit | What landed |
|--------|-------------|
| Phase 1 baseline | canonical-fact + synthesis-bridge prompts, 6h cooldown, recall boost |
| `33e2020` | Phase 1 ship merged to main |
| `5f454d8` | Phase 2 merged: delta-update REAFFIRM/EXTEND/CONTRADICT + confidence ladder + revision boost in recall |
| `c7c2877` | Phase 3 Move 1: cluster_index table + module + wiring |
| `c7c2877` (folded) | Phase 3 Move 2: EXTEND demotion + evidence cap |
| `978e059` + `661937f` | Phase 3 Move 3: crossClusterEntityBoost + recall-router wiring + hop1 shape fix |
| `2396141` | Fix: mapMemoryRecord includes synthesis fields (Phase 3 dead-on-arrival fix) |
| `68d10f9` | Entity-tag inheritance: synthesis inherits from evidence (4 paths + backfill pre-pass) |

---

## 14. Strategic frame

The cognition layer is what makes HIVEMIND defensible as **enterprise
memory infrastructure** rather than just a vector DB with tools.

Salesforce admitted (Feb 2026) that effective AI agents need memory that
**evolves with interactions**. They built a session-level memory layer
inside their walled garden. HIVEMIND is the **cross-system,
cross-tenant, compounding** memory layer that no single CRM vendor can
architect — their trust model (zero-retention LLM) prevents it.

The cognition loop is the heart of that compounding:
- Same evidence → same cluster → same synthesis (idempotent)
- New evidence → REAFFIRM (confidence ↑) or EXTEND (nuance ↑) or CONTRADICT (supersede)
- Recall ranks survived synthesis higher → agent answers improve over time
- cluster_index.recall_count_30d feeds priority for next tick → hot
  clusters get more attention

This is what "**system of memory**" vs "**system of record**" actually
means in code.

---

*Document version: 2026-05-25. Owner: HIVEMIND core team. For changes,
update this file alongside the corresponding code commit.*

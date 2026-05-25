# 2026-05-25 — Cognition Loop Phase 3: Enterprise Primitives

## Summary

Three hardening moves shipped and verified on prod. Builds on Phase 1 (canonical-fact + synthesis-bridge synthesis) and Phase 2 (delta-update semantics).

---

## Move 1: cluster_index table + module

### What
Durable cluster-state table so cognition-loop can target dirty clusters without full-scanning raw memories every tick.

### Schema
`cluster_index` (org, user, cluster_hash) UNIQUE. Columns: dirty_count, evidence_count, latest_synthesis_id, latest_revision, latest_confidence, last_tick_at, last_recall_at, recall_count_30d. GIN index on entity_keys.

### Module: core/src/memory/cluster-index.js
- `upsertOnSynthesis`: called after every synthesis write; resets dirty_count to 0
- `bumpDirty`: atomic raw SQL `UPDATE dirty_count += N`; creates stub row if missing
- `getDirtyClusters`: scheduler query (minDirty=3, ordered desc)
- `getClustersByEntityOverlap`: hasSome query for cross-cluster boost
- `recordRecall`: setImmediate metric bump (non-blocking)

### Bugs hit + fixed during ship
1. `bumpDirty` raw SQL: Prisma `$executeRawUnsafe` binds JS strings as `text` but column is `uuid`. Fixed: `$1::uuid` cast.
2. Raw SQL table reference: Prisma doesn't inherit `search_path`. Fixed: `hivemind.cluster_index` schema-qualified name.

### Backfill
`core/scripts/cluster-index-backfill.mjs --commit` — groups isLatest=true synthesis memories by clusterHash, populates entity_keys from proper-noun-like topic tags (since entity:* LLM tags don't stamp synthesis memories). Ran on prod: 27 clusters indexed, 5 with entity_keys.

---

## Move 2: EXTEND isLatest demotion + evidence cap

### What
- After EXTEND creates new synthesis, prior revision immediately set `isLatest=false`. Extends edge preserved for time-travel. Prevents double-surfacing in recall.
- Evidence cap: all delta-update paths (REAFFIRM/EXTEND/CONTRADICT) now cap `synthesisEvidenceIds` at top-20 most recent. Full count in `evidence_count_total`.

### Log evidence
`[cognition-loop] EXTEND: demoted prior <id8> isLatest=false (rev N → N+1)`

---

## Move 3: cross-cluster shared-entity boost

### What
Post-RRF pass in RecallRouter. For each memory with synthesisClusterHash, queries cluster_index for other clusters sharing entity_keys. Boosts up to ×1.35.

### Formula
`boost = 1 + min(0.30, 0.10 × overlap_count) + 0.05_if_high_conf_neighbor`

### Verified
Direct container test: DaVinci+CNJE canonical-fact and synthesis-bridge memories both boosted ×1.15 when both appear in same recall result set.

### Bugs hit + fixed
- `hop1Memory` shape stripped `synthesis_cluster_hash` — field wasn't passed through mapping. Fixed: spread it through explicitly.

---

## Commits

| Commit | Description |
|--------|-------------|
| c7c2877 | feat(cognition-loop): Move 1 — cluster_index table + module |
| 978e059 | feat(recall): Move 3 — cross-cluster shared-entity boost |
| 67e5720 | fix(cluster-index): backfill entity_keys from proper-noun tags |
| 661937f | fix(recall-router): pass synthesis_cluster_hash through hop1 shape |
| 1f4f1b0 | fix(cluster-index): schema-qualify raw SQL table refs |
| 9dc0404 | fix(cluster-index): cast UUID params in bumpDirty raw SQL (PG error 42804) |

---

## Prod state

- Migration applied: `20260525200000_cluster_index`
- Backfill: 27 cluster_index rows, 5 with entity_keys
- Eval: 11/18 (no regressions from baseline)
- Cross-cluster boost verified working in direct container test

---

## Pending / next

- Option B ingest-time dirty tracking: classify new memory into cluster_hash at ingest time via tag-pair matching
- `decayRecallCounts()` nightly job (Day 3)
- cluster_index entity_keys enrichment: run entity-co-mention LLM on synthesis memories to populate entity:* tags

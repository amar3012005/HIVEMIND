# P0 — optional first-class provenance columns (GATED — do NOT apply without owner confirm)

**Status:** authored, NOT applied. RISK-tier (schema migration on the hot, large,
multi-tenant `hivemind.memories` table). The working P0 provenance + actionable-gate
already ships WITHOUT this migration (provenance is stored via the existing
`source_platform` column + `source_metadata` JSON; the gate is sidecar-side, env-gated).

This migration is the **optional upgrade** to promote HyperAgents provenance to
first-class, queryable columns (for audit dashboards / SQL filters). Apply only if/when
you want that, after reviewing shadow-gate logs.

## Why it's safe (when you do apply it)
- Columns are **NULLABLE with no DEFAULT** → Postgres adds them as a metadata-only change
  (no full-table rewrite, no long lock). Existing rows stay NULL = "legacy / pre-provenance".
- **No backfill** in the migration (backfill separately, in batches, off-peak, if wanted).
- Index is created **CONCURRENTLY** (no write lock) and is `(org_id, produced_by_turn)` so
  multi-tenant audit queries don't cross-tenant scan.
- Fully reversible via down.sql.

## migration.sql  (place in core/prisma/migrations/<UTC-ts>_add_hyperagents_provenance/)
```sql
ALTER TABLE hivemind.memories
  ADD COLUMN IF NOT EXISTS produced_by_turn  uuid,
  ADD COLUMN IF NOT EXISTS produced_by_agent varchar(120),
  ADD COLUMN IF NOT EXISTS actionable        boolean,
  ADD COLUMN IF NOT EXISTS provenance        jsonb;

-- CONCURRENTLY must run outside a txn block; if the migration runner wraps in a txn,
-- run this index statement separately (prisma db execute) after the ALTER.
CREATE INDEX CONCURRENTLY IF NOT EXISTS memories_produced_by_turn_idx
  ON hivemind.memories (org_id, produced_by_turn)
  WHERE produced_by_turn IS NOT NULL;
```

## down.sql
```sql
DROP INDEX IF EXISTS hivemind.memories_produced_by_turn_idx;
ALTER TABLE hivemind.memories
  DROP COLUMN IF EXISTS produced_by_turn,
  DROP COLUMN IF EXISTS produced_by_agent,
  DROP COLUMN IF EXISTS actionable,
  DROP COLUMN IF EXISTS provenance;
```

## schema.prisma diff (Memory model) — add WITH the migration, then `prisma generate`
```prisma
  producedByTurn   String?  @map("produced_by_turn")  @db.Uuid
  producedByAgent  String?  @map("produced_by_agent") @db.VarChar(120)
  actionable       Boolean? @map("actionable")
  provenance       Json?    @map("provenance")
```

## Wiring after apply (follow-up, small)
- core `/api/memories` ingest: map `source_metadata.source_session_id → producedByTurn`,
  `source_metadata.produced_by → producedByAgent`, `source_metadata.actionable → actionable`,
  and store the whole `source_metadata` in `provenance`. (Today these already arrive in the
  body from the sidecar and land in `source_metadata`; this just denormalizes them to columns.)
- No sidecar change needed — it already sends the fields.

## Rollback
Run down.sql (drops index first, then columns). No data loss beyond the provenance columns
themselves (source_metadata JSON copy remains intact).

---
## UPDATE 2026-07-23 — APPLIED (columns live) + population caveat
- Columns + index APPLIED to prod hivemind.memories (verified), added to schema.prisma +
  migration 20260723090000, Prisma client regenerated, core deployed (prod-20260723-3e878fb5b),
  recall verified healthy. The MIGRATION is done.
- prisma-graph-store.createMemory populates the columns for hyperagents-agent saves (uuid-guarded,
  additive) — verified SAFE (non-HyperAgents saves unaffected).
- CAVEAT (scoped follow-up): the primary /api/memories path is the canonical V5 ingest, whose LLM
  normalizer REPLACES source_metadata with its extractor output (_normalized/factSentences/…),
  dropping produced_by/source_session_id BEFORE the create — so the columns do NOT auto-populate
  via that path yet. Provenance data still lives on the memory (source_platform='hyperagents').
  To auto-populate: preserve {produced_by, source_session_id, room_id, actionable} through the
  canonical normalizer → engine.ingestMemory → store.createMemory. Delicate hot-path change —
  intentionally NOT rushed. Columns/wiring are ready for when it's threaded.

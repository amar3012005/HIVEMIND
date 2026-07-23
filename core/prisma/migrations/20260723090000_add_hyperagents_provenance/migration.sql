-- P0: first-class HyperAgents provenance columns on hivemind.memories.
-- Additive, NULLABLE, no default → metadata-only (no table rewrite / no long lock).
-- Idempotent (IF NOT EXISTS) — applied live 2026-07-23 via direct SQL; this file records it.
ALTER TABLE "hivemind"."memories"
  ADD COLUMN IF NOT EXISTS "produced_by_turn"  uuid,
  ADD COLUMN IF NOT EXISTS "produced_by_agent" varchar(120),
  ADD COLUMN IF NOT EXISTS "actionable"        boolean,
  ADD COLUMN IF NOT EXISTS "provenance"        jsonb;

-- Audit index for HyperAgents provenance queries (per-tenant). CONCURRENTLY so it never
-- blocks writes; run outside a txn if the runner wraps migrations in one.
CREATE INDEX CONCURRENTLY IF NOT EXISTS "memories_produced_by_turn_idx"
  ON "hivemind"."memories" ("org_id", "produced_by_turn")
  WHERE "produced_by_turn" IS NOT NULL;

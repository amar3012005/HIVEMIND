-- C1 backstop: at most ONE is_latest synthesis per (org, synthesis_cluster_hash).
-- The transaction-scoped advisory lock in cognition-loop already serializes
-- synthesis creation per cluster, and H13 made create+demote ordered (demote
-- prior BEFORE creating the new revision), so no legitimate flow produces two
-- live rows per cluster hash. This partial unique index is the durable DB
-- backstop. Partial WHERE is not expressible in the Prisma DSL → migration-only
-- (applied live with CREATE INDEX CONCURRENTLY; IF NOT EXISTS keeps it idempotent).
CREATE UNIQUE INDEX IF NOT EXISTS memories_one_latest_synthesis_per_cluster
  ON hivemind.memories (org_id, synthesis_cluster_hash)
  WHERE is_latest = true AND deleted_at IS NULL AND synthesis_cluster_hash IS NOT NULL;

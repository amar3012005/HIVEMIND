-- Phase A — L2 principles tier.
--
-- Additive + idempotent. No column change: cognitive_layer_role already exists
-- and is nullable. Principles reuse the synthesis storage (memory_type =
-- 'synthesis', tag 'synthesis:principle', cognitive_layer_role = 'principle').
--
-- Partial index to keep the per-org "latest principles" lookup cheap as the
-- principle tier grows. WHERE-clause partial index is NOT expressible in the
-- Prisma schema DSL, so it lives here in raw SQL only (the schema carries a
-- comment pointing at this migration).
CREATE INDEX IF NOT EXISTS memories_principle_role_idx
  ON hivemind.memories (org_id, updated_at DESC)
  WHERE cognitive_layer_role = 'principle';

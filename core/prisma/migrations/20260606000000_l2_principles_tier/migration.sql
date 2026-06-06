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

-- Phase A also introduces the 'principle' value for cognitive_layer_role. The
-- pre-existing CHECK constraint enumerated only canonical/bridge/compression/
-- reflection, so principle inserts were rejected (23514). Widen it. Idempotent.
ALTER TABLE hivemind.memories
  DROP CONSTRAINT IF EXISTS memories_cognitive_layer_role_check;
ALTER TABLE hivemind.memories
  ADD CONSTRAINT memories_cognitive_layer_role_check
  CHECK (cognitive_layer_role IS NULL OR cognitive_layer_role = ANY (
    ARRAY['canonical','bridge','compression','reflection','principle']));

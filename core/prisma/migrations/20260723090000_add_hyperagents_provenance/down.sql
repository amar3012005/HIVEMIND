DROP INDEX IF EXISTS "hivemind"."memories_produced_by_turn_idx";
ALTER TABLE "hivemind"."memories"
  DROP COLUMN IF EXISTS "produced_by_turn",
  DROP COLUMN IF EXISTS "produced_by_agent",
  DROP COLUMN IF EXISTS "actionable",
  DROP COLUMN IF EXISTS "provenance";

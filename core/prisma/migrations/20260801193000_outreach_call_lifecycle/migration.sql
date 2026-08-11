ALTER TABLE "hivemind"."outreach_targets"
  ADD COLUMN IF NOT EXISTS "lead_id" UUID,
  ADD COLUMN IF NOT EXISTS "input_context" JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "hivemind"."outreach_targets"
  ALTER COLUMN "state" TYPE VARCHAR(20);

CREATE INDEX IF NOT EXISTS "outreach_targets_lead_id_idx"
  ON "hivemind"."outreach_targets" ("lead_id");

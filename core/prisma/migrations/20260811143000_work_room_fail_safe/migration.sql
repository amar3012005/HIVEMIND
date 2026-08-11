ALTER TABLE "hivemind"."hyper_turns"
  ADD COLUMN IF NOT EXISTS "execution_identity" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "execution_phase" VARCHAR(32) NOT NULL DEFAULT 'ACCEPTED',
  ADD COLUMN IF NOT EXISTS "candidate_output" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "verification_verdict" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "last_progress_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS "terminal_reason" TEXT;

CREATE INDEX IF NOT EXISTS "hyper_turns_status_last_progress_at_idx"
  ON "hivemind"."hyper_turns" ("status", "last_progress_at");

CREATE TABLE IF NOT EXISTS "hivemind"."hyper_turn_event_outbox" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "turn_id" UUID NOT NULL REFERENCES "hivemind"."hyper_turns"("id") ON DELETE CASCADE,
  "event_id" VARCHAR(120) NOT NULL,
  "event" JSONB NOT NULL,
  "delivered_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  UNIQUE ("turn_id", "event_id")
);

CREATE INDEX IF NOT EXISTS "hyper_turn_event_outbox_pending_idx"
  ON "hivemind"."hyper_turn_event_outbox" ("created_at")
  WHERE "delivered_at" IS NULL;

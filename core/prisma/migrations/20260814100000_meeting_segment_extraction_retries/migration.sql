-- Durable, bounded retry state for progressive meeting segment extraction.
ALTER TABLE "hivemind"."meeting_segments"
  ADD COLUMN IF NOT EXISTS "extraction_attempts" int NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "extraction_next_attempt_at" timestamptz(6),
  ADD COLUMN IF NOT EXISTS "extraction_lease_expires_at" timestamptz(6),
  ADD COLUMN IF NOT EXISTS "extraction_last_error" text;

CREATE INDEX IF NOT EXISTS "meeting_segments_extraction_retry_idx"
  ON "hivemind"."meeting_segments" ("extraction_status", "extraction_next_attempt_at", "created_at");

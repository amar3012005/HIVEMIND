-- P1: durable per-segment meeting transcript (crash-recovery). Additive.
CREATE TABLE IF NOT EXISTS "hivemind"."meeting_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL,
  "meeting_id" uuid REFERENCES "hivemind"."meetings"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "idx" int NOT NULL,
  "text" text NOT NULL,
  "speakers" jsonb,
  "start_ms" int,
  "end_ms" int,
  "status" varchar(16) NOT NULL DEFAULT 'transcribed',
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "meeting_segments_session_idx_key" ON "hivemind"."meeting_segments" ("session_id","idx");
CREATE INDEX IF NOT EXISTS "meeting_segments_meeting_idx" ON "hivemind"."meeting_segments" ("meeting_id");
CREATE INDEX IF NOT EXISTS "meeting_segments_org_user_idx" ON "hivemind"."meeting_segments" ("org_id","user_id");

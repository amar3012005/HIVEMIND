-- Meeting recorder durability, Phase 1.
-- A meeting is created only after finalization. This table owns the recording
-- lifecycle before that point, so recovery and retry state is not browser-only.
CREATE TABLE IF NOT EXISTS "hivemind"."meeting_sessions" (
  "id" uuid PRIMARY KEY,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "status" varchar(24) NOT NULL DEFAULT 'recording',
  "consent_recorded" boolean NOT NULL DEFAULT false,
  "expected_segment_ms" int NOT NULL DEFAULT 600000,
  "expected_segments" int,
  "finalized_meeting_id" uuid,
  "failure_code" varchar(80),
  "failure_detail" text,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
  "finalized_at" timestamptz(6)
);

CREATE INDEX IF NOT EXISTS "meeting_sessions_org_user_status_idx"
  ON "hivemind"."meeting_sessions" ("org_id", "user_id", "status", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "meeting_sessions_finalized_meeting_idx"
  ON "hivemind"."meeting_sessions" ("finalized_meeting_id");

-- Audio bytes live in a tenant-selected durable volume/object store. Postgres
-- holds only lifecycle metadata, checksum and retry leases; never five hours
-- of opaque recorder blobs.
CREATE TABLE IF NOT EXISTS "hivemind"."meeting_audio_segments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "session_id" uuid NOT NULL,
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "idx" integer NOT NULL,
  "storage_key" text NOT NULL,
  "checksum" varchar(64) NOT NULL,
  "content_type" varchar(160) NOT NULL,
  "byte_size" integer NOT NULL,
  "start_ms" integer,
  "end_ms" integer,
  "status" varchar(16) NOT NULL DEFAULT 'queued',
  "attempts" integer NOT NULL DEFAULT 0,
  "next_attempt_at" timestamptz(6),
  "lease_expires_at" timestamptz(6),
  "last_error" text,
  "created_at" timestamptz(6) NOT NULL DEFAULT now(),
  "updated_at" timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT "meeting_audio_segments_session_idx_key" UNIQUE ("session_id", "idx")
);
CREATE INDEX IF NOT EXISTS "meeting_audio_segments_retry_idx"
  ON "hivemind"."meeting_audio_segments" ("status", "next_attempt_at", "created_at");
CREATE INDEX IF NOT EXISTS "meeting_audio_segments_owner_idx"
  ON "hivemind"."meeting_audio_segments" ("org_id", "user_id", "session_id");

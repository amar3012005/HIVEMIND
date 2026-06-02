-- AI Meeting Notes — org-level persistent record of recorded meetings + insights.
-- Additive only. Written by POST /api/meetings alongside the generic memories row.

CREATE TABLE IF NOT EXISTS "meetings" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id"          UUID NOT NULL,
    "org_id"           UUID NOT NULL,
    "project_id"       UUID,
    "title"            TEXT NOT NULL,
    "summary"          TEXT,
    "transcript"       TEXT,
    "language"         VARCHAR(16),
    "duration_sec"     INTEGER,
    "audio_bytes"      INTEGER,
    "multi_speaker"    BOOLEAN NOT NULL DEFAULT false,
    "speaker_count"    INTEGER,
    "action_items"     JSONB NOT NULL DEFAULT '[]',
    "decisions"        JSONB NOT NULL DEFAULT '[]',
    "key_points"       JSONB NOT NULL DEFAULT '[]',
    "questions"        JSONB NOT NULL DEFAULT '[]',
    "segments"         JSONB,
    "topics"           TEXT[] NOT NULL DEFAULT '{}',
    "sentiment"        VARCHAR(32),
    "source_memory_id" UUID,
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "updated_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
    "deleted_at"       TIMESTAMPTZ(6),
    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "meetings_org_created_idx" ON "meetings"("org_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "meetings_user_idx"        ON "meetings"("user_id");

-- HQ control-room activity feed: one row per non-HQ room run that seals.
-- Additive only. Down path in down.sql.

CREATE TABLE IF NOT EXISTS "hivemind"."hq_activity" (
    "id"               UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"           UUID NOT NULL,
    "hq_room_id"       UUID NOT NULL,
    "source_room_id"   UUID NOT NULL,
    "source_room_name" VARCHAR(200),
    "turn_id"          UUID NOT NULL,
    "agent_name"       VARCHAR(120),
    "agent_role"       VARCHAR(120),
    "headline"         VARCHAR(400) NOT NULL,
    "summary"          TEXT,
    "status"           VARCHAR(20) NOT NULL DEFAULT 'complete',
    "created_at"       TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "hq_activity_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "hq_activity_turn_id_key" UNIQUE ("turn_id")
);

CREATE INDEX IF NOT EXISTS "hq_activity_org_hq_created_idx"
    ON "hivemind"."hq_activity"("org_id", "hq_room_id", "created_at");

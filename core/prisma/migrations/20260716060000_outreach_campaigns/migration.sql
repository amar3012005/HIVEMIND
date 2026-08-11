-- Outreach campaign runner: durable batch email/call campaigns over Places prospects.
-- Additive only. Down path: down.sql alongside this file.

CREATE TABLE IF NOT EXISTS "hivemind"."outreach_campaigns" (
    "id"           UUID NOT NULL DEFAULT gen_random_uuid(),
    "room_id"      UUID NOT NULL,
    "turn_id"      UUID NOT NULL,
    "user_id"      UUID NOT NULL,
    "org_id"       UUID NOT NULL,
    "channel"      VARCHAR(8) NOT NULL,
    "status"       VARCHAR(12) NOT NULL DEFAULT 'queued',
    "sender_email" VARCHAR(160),
    "tara_number"  VARCHAR(32),
    "last_tick_at" TIMESTAMPTZ(6),
    "created_at"   TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "started_at"   TIMESTAMPTZ(6),
    "finished_at"  TIMESTAMPTZ(6),

    CONSTRAINT "outreach_campaigns_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "outreach_campaigns_user_id_status_created_at_idx"
    ON "hivemind"."outreach_campaigns"("user_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "outreach_campaigns_org_id_status_idx"
    ON "hivemind"."outreach_campaigns"("org_id", "status");
CREATE INDEX IF NOT EXISTS "outreach_campaigns_turn_id_idx"
    ON "hivemind"."outreach_campaigns"("turn_id");

CREATE TABLE IF NOT EXISTS "hivemind"."outreach_targets" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "campaign_id" UUID NOT NULL,
    "position"    INTEGER NOT NULL,
    "company"     VARCHAR(300) NOT NULL,
    "email"       VARCHAR(320),
    "phone"       VARCHAR(40),
    "website"     VARCHAR(500),
    "address"     VARCHAR(500),
    "payload"     JSONB,
    "state"       VARCHAR(12) NOT NULL DEFAULT 'selected',
    "result_ref"  JSONB,
    "updated_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outreach_targets_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "outreach_targets_campaign_id_fkey" FOREIGN KEY ("campaign_id")
        REFERENCES "hivemind"."outreach_campaigns"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "outreach_targets_campaign_id_position_idx"
    ON "hivemind"."outreach_targets"("campaign_id", "position");
CREATE INDEX IF NOT EXISTS "outreach_targets_campaign_id_state_idx"
    ON "hivemind"."outreach_targets"("campaign_id", "state");

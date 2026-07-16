-- Outbound value-action ledger (HyperAgents closed loop).
-- One row per action that actually left the platform (email send / TARA call);
-- `outcome` filled later by reply-matcher / call-end insight.
-- Down: DROP TABLE IF EXISTS "hivemind"."outbound_actions";

CREATE TABLE IF NOT EXISTS "hivemind"."outbound_actions" (
    "id"          UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id"      UUID NOT NULL,
    "user_id"     UUID,
    "room_id"     UUID,
    "approval_id" VARCHAR(80),
    "channel"     VARCHAR(20) NOT NULL,
    "recipient"   VARCHAR(320),
    "subject"     VARCHAR(500),
    "message_id"  VARCHAR(160),
    "thread_id"   VARCHAR(160),
    "status"      VARCHAR(20) NOT NULL DEFAULT 'sent',
    "outcome"     VARCHAR(40),
    "outcome_at"  TIMESTAMPTZ(6),
    "meta"        JSONB,
    "sent_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbound_actions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "outbound_actions_org_id_sent_at_idx" ON "hivemind"."outbound_actions"("org_id", "sent_at");
CREATE INDEX IF NOT EXISTS "outbound_actions_org_id_thread_id_idx" ON "hivemind"."outbound_actions"("org_id", "thread_id");
CREATE INDEX IF NOT EXISTS "outbound_actions_org_id_outcome_sent_at_idx" ON "hivemind"."outbound_actions"("org_id", "outcome", "sent_at");

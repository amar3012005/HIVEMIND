-- ============================================================
-- Migration: connector_webhooks
-- Aligned with Prisma models WebhookSubscription / WebhookEvent.
-- ============================================================

BEGIN;

-- CreateTable: webhook_subscriptions
CREATE TABLE IF NOT EXISTS "webhook_subscriptions" (
    "id"                       UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id"                  UUID NOT NULL,
    "org_id"                   UUID NOT NULL,
    "provider_key"             VARCHAR(100) NOT NULL,
    "external_id"              VARCHAR(255) NOT NULL,
    "webhook_secret_encrypted" VARCHAR(255),
    "event_types"              TEXT[],
    "webhook_url"              TEXT NOT NULL,
    "registered_at"            TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_event_at"            TIMESTAMPTZ(6),
    "consecutive_failures"     INTEGER NOT NULL DEFAULT 0,
    "status"                   VARCHAR(20) NOT NULL DEFAULT 'active',
    "updated_at"               TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "webhook_subscriptions_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_subscriptions_status_check"
      CHECK ("status" IN ('active','paused','revoked'))
);

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_subscriptions_org_id_provider_key_external_id_key"
  ON "webhook_subscriptions"("org_id", "provider_key", "external_id");
CREATE INDEX IF NOT EXISTS "webhook_subscriptions_user_id_org_id_idx"
  ON "webhook_subscriptions"("user_id", "org_id");
CREATE INDEX IF NOT EXISTS "webhook_subscriptions_org_id_provider_key_idx"
  ON "webhook_subscriptions"("org_id", "provider_key");

-- CreateTable: webhook_events
CREATE TABLE IF NOT EXISTS "webhook_events" (
    "id"              UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscription_id" UUID,
    "org_id"          UUID NOT NULL,
    "provider_key"    VARCHAR(100) NOT NULL,
    "event_id"        VARCHAR(255),
    "event_type"      VARCHAR(100),
    "received_at"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processed_at"    TIMESTAMPTZ(6),
    "status"          VARCHAR(20) NOT NULL DEFAULT 'received',
    "payload"         JSONB,
    "error"           TEXT,
    "attempts"        INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "webhook_events_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "webhook_events_status_check"
      CHECK ("status" IN ('received','processing','processed','failed','dead_lettered')),
    CONSTRAINT "webhook_events_subscription_id_fkey"
      FOREIGN KEY ("subscription_id") REFERENCES "webhook_subscriptions"("id")
      ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "webhook_events_org_id_provider_key_event_id_key"
  ON "webhook_events"("org_id", "provider_key", "event_id");
CREATE INDEX IF NOT EXISTS "webhook_events_subscription_id_received_at_idx"
  ON "webhook_events"("subscription_id", "received_at" DESC);
CREATE INDEX IF NOT EXISTS "webhook_events_org_id_received_at_idx"
  ON "webhook_events"("org_id", "received_at" DESC);
CREATE INDEX IF NOT EXISTS "webhook_events_pending_received_at_idx"
  ON "webhook_events" ("received_at")
  WHERE "status" = 'received';

-- Nango connections metadata GIN index (table exists from prior migration)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'nango_connections'
  ) THEN
    CREATE INDEX IF NOT EXISTS "nango_connections_metadata_gin_idx"
      ON "nango_connections" USING GIN ("metadata" jsonb_path_ops);
    COMMENT ON COLUMN "nango_connections"."metadata" IS
      'Shape: { syncConfig: { intervalMinutes, scope, lastFullSyncAt }, cursor, externalIds }';
  END IF;
END$$;

COMMIT;

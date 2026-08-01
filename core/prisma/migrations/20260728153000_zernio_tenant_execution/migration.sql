-- White-label Zernio execution profiles. Additive and idempotent; apply through
-- the repository's reviewed manual SQL production procedure.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "hivemind"."zernio_org_profiles" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "zernio_profile_id" VARCHAR(80) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'ACTIVE',
  "display_name" VARCHAR(255) NOT NULL,
  "connected_accounts" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "capabilities" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "selected_ad_accounts" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_by" UUID,
  "last_synced_at" TIMESTAMPTZ,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "zernio_org_profiles_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "hivemind"."organizations"("id") ON DELETE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "zernio_org_profiles_org_id_key"
  ON "hivemind"."zernio_org_profiles"("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "zernio_org_profiles_provider_id_key"
  ON "hivemind"."zernio_org_profiles"("zernio_profile_id");
CREATE INDEX IF NOT EXISTS "zernio_org_profiles_status_synced_idx"
  ON "hivemind"."zernio_org_profiles"("status", "last_synced_at");

ALTER TABLE "hivemind"."zernio_org_profiles"
  ADD COLUMN IF NOT EXISTS "selected_ad_accounts" JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE TABLE IF NOT EXISTS "hivemind"."zernio_webhook_events" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "provider_event_id" VARCHAR(100) NOT NULL,
  "event_type" VARCHAR(100) NOT NULL,
  "provider_profile_id" VARCHAR(80),
  "org_id" UUID,
  "status" VARCHAR(24) NOT NULL DEFAULT 'ACCEPTED',
  "payload" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "error" TEXT,
  "received_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "processed_at" TIMESTAMPTZ,
  CONSTRAINT "zernio_webhook_events_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "hivemind"."organizations"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "zernio_webhook_events_provider_event_id_key"
  ON "hivemind"."zernio_webhook_events"("provider_event_id");
CREATE INDEX IF NOT EXISTS "zernio_webhook_events_org_received_idx"
  ON "hivemind"."zernio_webhook_events"("org_id", "received_at" DESC);
CREATE INDEX IF NOT EXISTS "zernio_webhook_events_status_received_idx"
  ON "hivemind"."zernio_webhook_events"("status", "received_at");

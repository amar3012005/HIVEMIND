-- Singulance Campaigns V2 foundation. Additive and idempotent by design.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS "hivemind"."audience_contacts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "created_by" UUID,
  "lifecycle" VARCHAR(24) NOT NULL DEFAULT 'PROSPECT',
  "display_name" VARCHAR(255), "company" VARCHAR(300), "email" VARCHAR(320),
  "phone" VARCHAR(40), "website" VARCHAR(500), "address" VARCHAR(500),
  "country" VARCHAR(2), "timezone" VARCHAR(80),
  "dedupe_key" VARCHAR(700) NOT NULL,
  "source_type" VARCHAR(40) NOT NULL DEFAULT 'manual', "source_ref" VARCHAR(200),
  "provenance" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "consent" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "enrichment" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "last_contacted_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "audience_contacts_org_id_dedupe_key_key" ON "hivemind"."audience_contacts"("org_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "audience_contacts_org_lifecycle_updated_idx" ON "hivemind"."audience_contacts"("org_id", "lifecycle", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "audience_contacts_org_email_idx" ON "hivemind"."audience_contacts"("org_id", "email");
CREATE INDEX IF NOT EXISTS "audience_contacts_org_phone_idx" ON "hivemind"."audience_contacts"("org_id", "phone");

CREATE TABLE IF NOT EXISTS "hivemind"."campaigns" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL, "owner_user_id" UUID NOT NULL, "creation_key" VARCHAR(160),
  "name" VARCHAR(255) NOT NULL, "objective" VARCHAR(40) NOT NULL, "goal" TEXT NOT NULL,
  "brief" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "requirements" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "requested_channels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "audience_policy" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "schedule_policy" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "autonomy_mode" VARCHAR(32) NOT NULL DEFAULT 'APPROVE_PLAN_ONCE',
  "status" VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  "room_id" UUID, "current_plan_version_id" UUID, "approved_plan_version_id" UUID,
  "source_type" VARCHAR(40), "source_id" UUID,
  "baseline" JSONB NOT NULL DEFAULT '{}'::jsonb, "last_error" TEXT,
  "started_at" TIMESTAMPTZ, "paused_at" TIMESTAMPTZ, "completed_at" TIMESTAMPTZ, "cancelled_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_room_id_key" ON "hivemind"."campaigns"("room_id") WHERE "room_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_legacy_source_key" ON "hivemind"."campaigns"("org_id", "source_type", "source_id") WHERE "source_type" IS NOT NULL AND "source_id" IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS "campaigns_creation_key" ON "hivemind"."campaigns"("org_id", "owner_user_id", "creation_key") WHERE "creation_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "campaigns_org_status_created_idx" ON "hivemind"."campaigns"("org_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "campaigns_owner_created_idx" ON "hivemind"."campaigns"("owner_user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "hivemind"."campaign_channels" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "campaign_id" UUID NOT NULL,
  "channel" VARCHAR(40) NOT NULL, "status" VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  "connection_ref" JSONB NOT NULL DEFAULT '{}'::jsonb, "config" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "metrics" JSONB NOT NULL DEFAULT '{}'::jsonb, "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_channels_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "hivemind"."campaigns"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_channels_campaign_channel_key" ON "hivemind"."campaign_channels"("campaign_id", "channel");
CREATE INDEX IF NOT EXISTS "campaign_channels_campaign_status_idx" ON "hivemind"."campaign_channels"("campaign_id", "status");

CREATE TABLE IF NOT EXISTS "hivemind"."campaign_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "campaign_id" UUID NOT NULL,
  "room_id" UUID, "turn_id" UUID, "status" VARCHAR(24) NOT NULL DEFAULT 'QUEUED',
  "brief_snapshot" JSONB NOT NULL, "validation" JSONB NOT NULL DEFAULT '{}'::jsonb, "error" TEXT,
  "started_at" TIMESTAMPTZ, "completed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_runs_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "hivemind"."campaigns"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_runs_turn_id_key" ON "hivemind"."campaign_runs"("turn_id") WHERE "turn_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "campaign_runs_campaign_created_idx" ON "hivemind"."campaign_runs"("campaign_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "campaign_runs_status_created_idx" ON "hivemind"."campaign_runs"("status", "created_at");

CREATE TABLE IF NOT EXISTS "hivemind"."campaign_plan_versions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "campaign_id" UUID NOT NULL, "version" INTEGER NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'GENERATING', "canonical_hash" VARCHAR(64),
  "bundle" JSONB NOT NULL DEFAULT '{}'::jsonb, "report_markdown" TEXT,
  "validation" JSONB NOT NULL DEFAULT '{}'::jsonb, "created_by" UUID,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "ready_at" TIMESTAMPTZ,
  CONSTRAINT "campaign_plan_versions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "hivemind"."campaigns"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_plan_versions_campaign_version_key" ON "hivemind"."campaign_plan_versions"("campaign_id", "version");
CREATE INDEX IF NOT EXISTS "campaign_plan_versions_campaign_status_idx" ON "hivemind"."campaign_plan_versions"("campaign_id", "status");

CREATE TABLE IF NOT EXISTS "hivemind"."campaign_audience_members" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "campaign_id" UUID NOT NULL, "contact_id" UUID,
  "source_type" VARCHAR(40) NOT NULL, "source_ref" VARCHAR(200), "dedupe_key" VARCHAR(700) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'PROPOSED', "snapshot" JSONB NOT NULL,
  "evidence" JSONB NOT NULL DEFAULT '{}'::jsonb, "approved_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_audience_members_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "hivemind"."campaigns"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_audience_members_contact_id_fkey" FOREIGN KEY ("contact_id") REFERENCES "hivemind"."audience_contacts"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_audience_members_campaign_dedupe_key" ON "hivemind"."campaign_audience_members"("campaign_id", "dedupe_key");
CREATE INDEX IF NOT EXISTS "campaign_audience_members_campaign_status_idx" ON "hivemind"."campaign_audience_members"("campaign_id", "status");
CREATE INDEX IF NOT EXISTS "campaign_audience_members_contact_idx" ON "hivemind"."campaign_audience_members"("contact_id");

CREATE TABLE IF NOT EXISTS "hivemind"."campaign_actions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "campaign_id" UUID NOT NULL, "plan_version_id" UUID NOT NULL,
  "audience_member_id" UUID, "channel" VARCHAR(40) NOT NULL, "action_type" VARCHAR(40) NOT NULL,
  "position" INTEGER NOT NULL, "status" VARCHAR(24) NOT NULL DEFAULT 'DRAFT',
  "scheduled_at" TIMESTAMPTZ, "expires_at" TIMESTAMPTZ, "payload" JSONB NOT NULL,
  "rationale" TEXT, "success_metric" VARCHAR(200), "idempotency_key" VARCHAR(160) NOT NULL,
  "external_id" VARCHAR(200), "lease_owner" VARCHAR(160), "lease_expires_at" TIMESTAMPTZ,
  "last_error" TEXT, "executed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_actions_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "hivemind"."campaigns"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_actions_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "hivemind"."campaign_plan_versions"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_actions_audience_member_id_fkey" FOREIGN KEY ("audience_member_id") REFERENCES "hivemind"."campaign_audience_members"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_actions_campaign_idempotency_key" ON "hivemind"."campaign_actions"("campaign_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "campaign_actions_due_lease_idx" ON "hivemind"."campaign_actions"("status", "scheduled_at", "lease_expires_at");
CREATE INDEX IF NOT EXISTS "campaign_actions_campaign_status_position_idx" ON "hivemind"."campaign_actions"("campaign_id", "status", "position");
CREATE INDEX IF NOT EXISTS "campaign_actions_plan_version_idx" ON "hivemind"."campaign_actions"("plan_version_id");

CREATE TABLE IF NOT EXISTS "hivemind"."campaign_action_attempts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "action_id" UUID NOT NULL, "attempt" INTEGER NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'RUNNING', "request_hash" VARCHAR(64), "external_id" VARCHAR(200),
  "response" JSONB, "error" TEXT, "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "completed_at" TIMESTAMPTZ,
  CONSTRAINT "campaign_action_attempts_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "hivemind"."campaign_actions"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS "campaign_action_attempts_action_attempt_key" ON "hivemind"."campaign_action_attempts"("action_id", "attempt");
CREATE INDEX IF NOT EXISTS "campaign_action_attempts_action_status_idx" ON "hivemind"."campaign_action_attempts"("action_id", "status");

CREATE TABLE IF NOT EXISTS "hivemind"."campaign_approvals" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "campaign_id" UUID NOT NULL, "plan_version_id" UUID NOT NULL,
  "actor_user_id" UUID NOT NULL, "canonical_hash" VARCHAR(64) NOT NULL, "channels" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "recipient_count" INTEGER NOT NULL DEFAULT 0, "caps" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "autonomy_mode" VARCHAR(32) NOT NULL, "status" VARCHAR(20) NOT NULL DEFAULT 'ACTIVE',
  "approved_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "revoked_at" TIMESTAMPTZ,
  CONSTRAINT "campaign_approvals_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "hivemind"."campaigns"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_approvals_plan_version_id_fkey" FOREIGN KEY ("plan_version_id") REFERENCES "hivemind"."campaign_plan_versions"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "campaign_approvals_campaign_status_approved_idx" ON "hivemind"."campaign_approvals"("campaign_id", "status", "approved_at" DESC);
CREATE INDEX IF NOT EXISTS "campaign_approvals_plan_version_idx" ON "hivemind"."campaign_approvals"("plan_version_id");

CREATE TABLE IF NOT EXISTS "hivemind"."campaign_assets" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "campaign_id" UUID NOT NULL, "action_id" UUID,
  "kind" VARCHAR(32) NOT NULL, "status" VARCHAR(24) NOT NULL DEFAULT 'GENERATING',
  "storage_key" VARCHAR(1000), "content_hash" VARCHAR(64), "content_type" VARCHAR(80), "size_bytes" INTEGER,
  "width" INTEGER, "height" INTEGER, "provider" VARCHAR(60), "model" VARCHAR(120), "prompt" TEXT,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(), "deleted_at" TIMESTAMPTZ,
  CONSTRAINT "campaign_assets_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "hivemind"."campaigns"("id") ON DELETE CASCADE,
  CONSTRAINT "campaign_assets_action_id_fkey" FOREIGN KEY ("action_id") REFERENCES "hivemind"."campaign_actions"("id") ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS "campaign_assets_campaign_status_idx" ON "hivemind"."campaign_assets"("campaign_id", "status");
CREATE INDEX IF NOT EXISTS "campaign_assets_action_idx" ON "hivemind"."campaign_assets"("action_id");

CREATE TABLE IF NOT EXISTS "hivemind"."campaign_events" (
  "id" BIGSERIAL PRIMARY KEY, "campaign_id" UUID NOT NULL, "org_id" UUID NOT NULL,
  "event_type" VARCHAR(60) NOT NULL, "actor_type" VARCHAR(24) NOT NULL DEFAULT 'system', "actor_id" UUID,
  "data" JSONB NOT NULL DEFAULT '{}'::jsonb, "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_events_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "hivemind"."campaigns"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "campaign_events_campaign_id_idx" ON "hivemind"."campaign_events"("campaign_id", "id");
CREATE INDEX IF NOT EXISTS "campaign_events_org_created_idx" ON "hivemind"."campaign_events"("org_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "hivemind"."campaign_metric_snapshots" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "campaign_id" UUID NOT NULL,
  "channel" VARCHAR(40), "action_id" UUID, "period" VARCHAR(24) NOT NULL, "metrics" JSONB NOT NULL,
  "captured_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "campaign_metric_snapshots_campaign_id_fkey" FOREIGN KEY ("campaign_id") REFERENCES "hivemind"."campaigns"("id") ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS "campaign_metric_snapshots_campaign_captured_idx" ON "hivemind"."campaign_metric_snapshots"("campaign_id", "captured_at" DESC);
CREATE INDEX IF NOT EXISTS "campaign_metric_snapshots_campaign_channel_idx" ON "hivemind"."campaign_metric_snapshots"("campaign_id", "channel", "captured_at" DESC);

ALTER TABLE IF EXISTS "hivemind"."outbound_actions" ADD COLUMN IF NOT EXISTS "campaign_id" UUID;
ALTER TABLE IF EXISTS "hivemind"."outbound_actions" ADD COLUMN IF NOT EXISTS "campaign_action_id" UUID;
ALTER TABLE IF EXISTS "hivemind"."outreach_campaigns" ADD COLUMN IF NOT EXISTS "unified_campaign_id" UUID;
ALTER TABLE IF EXISTS "hivemind"."tara_campaigns" ADD COLUMN IF NOT EXISTS "unified_campaign_id" UUID;
ALTER TABLE IF EXISTS "hivemind"."x_ads_campaigns" ADD COLUMN IF NOT EXISTS "unified_campaign_id" UUID;

DO $campaign_legacy_indexes$
BEGIN
  IF to_regclass('hivemind.outbound_actions') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "outbound_actions_campaign_sent_idx" ON "hivemind"."outbound_actions"("campaign_id", "sent_at");
    CREATE INDEX IF NOT EXISTS "outbound_actions_campaign_action_idx" ON "hivemind"."outbound_actions"("campaign_action_id");
  END IF;
  IF to_regclass('hivemind.outreach_campaigns') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "outreach_campaigns_unified_campaign_idx" ON "hivemind"."outreach_campaigns"("unified_campaign_id");
  END IF;
  IF to_regclass('hivemind.tara_campaigns') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "tara_campaigns_unified_campaign_idx" ON "hivemind"."tara_campaigns"("unified_campaign_id");
  END IF;
  IF to_regclass('hivemind.x_ads_campaigns') IS NOT NULL THEN
    CREATE INDEX IF NOT EXISTS "x_ads_campaigns_unified_campaign_idx" ON "hivemind"."x_ads_campaigns"("unified_campaign_id");
  END IF;
END
$campaign_legacy_indexes$;

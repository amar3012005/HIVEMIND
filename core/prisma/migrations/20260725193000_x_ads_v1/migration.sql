SET search_path TO hivemind, public;

CREATE TABLE IF NOT EXISTS "x_ads_campaigns" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "ad_account_id" VARCHAR(64),
  "ad_account_name" VARCHAR(255),
  "funding_instrument_id" VARCHAR(64),
  "x_user_id" VARCHAR(32),
  "x_username" VARCHAR(64),
  "name" VARCHAR(255) NOT NULL,
  "destination_url" VARCHAR(2048) NOT NULL,
  "post_text" VARCHAR(500) NOT NULL,
  "image_data" BYTEA,
  "image_content_type" VARCHAR(64),
  "image_filename" VARCHAR(255),
  "location_targets" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "language_targets" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "daily_budget_micros" BIGINT,
  "total_budget_micros" BIGINT,
  "currency" VARCHAR(8),
  "account_timezone" VARCHAR(80),
  "end_date" VARCHAR(10) NOT NULL,
  "end_at" TIMESTAMPTZ,
  "status" VARCHAR(32) NOT NULL DEFAULT 'DRAFT',
  "draft_version" INTEGER NOT NULL DEFAULT 1,
  "confirmation_hash" VARCHAR(64),
  "confirmation_expires_at" TIMESTAMPTZ,
  "publish_lock_at" TIMESTAMPTZ,
  "x_campaign_id" VARCHAR(64),
  "x_line_item_id" VARCHAR(64),
  "x_media_id" VARCHAR(32),
  "x_post_id" VARCHAR(32),
  "x_promoted_tweet_id" VARCHAR(64),
  "x_approval_status" VARCHAR(32),
  "x_effective_status" VARCHAR(64),
  "x_snapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "metrics" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "metrics_synced_at" TIMESTAMPTZ,
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  "published_at" TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS "x_ads_campaign_steps" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "campaign_id" UUID NOT NULL REFERENCES "x_ads_campaigns"("id") ON DELETE CASCADE,
  "step" VARCHAR(40) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  "external_id" VARCHAR(80),
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "response" JSONB,
  "error" TEXT,
  "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT "x_ads_campaign_steps_campaign_step_key" UNIQUE ("campaign_id", "step")
);

CREATE UNIQUE INDEX IF NOT EXISTS "x_ads_campaigns_org_x_campaign_key"
  ON "x_ads_campaigns"("org_id", "x_campaign_id") WHERE "x_campaign_id" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "x_ads_campaigns_org_status_created_idx"
  ON "x_ads_campaigns"("org_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "x_ads_campaigns_user_created_idx"
  ON "x_ads_campaigns"("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "x_ads_campaign_steps_campaign_status_idx"
  ON "x_ads_campaign_steps"("campaign_id", "status");

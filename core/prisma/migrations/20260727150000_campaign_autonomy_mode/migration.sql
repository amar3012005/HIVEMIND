ALTER TABLE "hivemind"."organizations"
  ADD COLUMN IF NOT EXISTS "campaign_autonomy_mode" VARCHAR(24) NOT NULL DEFAULT 'MANUAL_REVIEW';

ALTER TABLE "hivemind"."organizations"
  DROP CONSTRAINT IF EXISTS "organizations_campaign_autonomy_mode_check";

ALTER TABLE "hivemind"."organizations"
  ADD CONSTRAINT "organizations_campaign_autonomy_mode_check"
  CHECK ("campaign_autonomy_mode" IN ('MANUAL_REVIEW', 'AUTO'));

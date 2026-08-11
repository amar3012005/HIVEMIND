ALTER TABLE "hivemind"."tara_call_attempts"
  ADD COLUMN IF NOT EXISTS "requested_session_id" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "runtime_playbook_run_id" UUID,
  ADD COLUMN IF NOT EXISTS "runtime_stage_id" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "outreach_campaign_id" UUID,
  ADD COLUMN IF NOT EXISTS "outreach_target_id" UUID,
  ADD COLUMN IF NOT EXISTS "lead_id" UUID,
  ADD COLUMN IF NOT EXISTS "outbound_action_id" UUID,
  ADD COLUMN IF NOT EXISTS "authority_ref" VARCHAR(160),
  ADD COLUMN IF NOT EXISTS "reconciliation_state" VARCHAR(32) NOT NULL DEFAULT 'pending',
  ADD COLUMN IF NOT EXISTS "provider_candidates" JSONB NOT NULL DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS "last_error" TEXT;

CREATE INDEX IF NOT EXISTS "tara_call_attempts_runtime_stage_idx"
  ON "hivemind"."tara_call_attempts" ("runtime_playbook_run_id", "runtime_stage_id");
CREATE INDEX IF NOT EXISTS "tara_call_attempts_outreach_target_idx"
  ON "hivemind"."tara_call_attempts" ("outreach_campaign_id", "outreach_target_id");
CREATE INDEX IF NOT EXISTS "tara_call_attempts_reconciliation_idx"
  ON "hivemind"."tara_call_attempts" ("org_id", "reconciliation_state", "updated_at");

ALTER TABLE "hivemind"."runtime_playbook_runs"
  ADD COLUMN IF NOT EXISTS "parent_run_id" UUID,
  ADD COLUMN IF NOT EXISTS "parent_stage_id" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "item_key" VARCHAR(160),
  ADD COLUMN IF NOT EXISTS "position" INTEGER;

CREATE INDEX IF NOT EXISTS "runtime_playbook_runs_parent_position_idx"
  ON "hivemind"."runtime_playbook_runs" ("parent_run_id", "position");

CREATE TABLE IF NOT EXISTS "hivemind"."capability_adapter_states" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "org_id" uuid NOT NULL,
  "capability_key" varchar(120) NOT NULL, "adapter_id" varchar(120) NOT NULL,
  "state" varchar(32) NOT NULL, "consecutive_negatives" integer NOT NULL DEFAULT 0,
  "last_good_at" timestamptz, "last_checked_at" timestamptz NOT NULL DEFAULT now(),
  "expires_at" timestamptz NOT NULL, "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT "capability_adapter_states_org_capability_adapter_key" UNIQUE ("org_id", "capability_key", "adapter_id")
);
CREATE INDEX IF NOT EXISTS "capability_adapter_states_lookup_idx"
  ON "hivemind"."capability_adapter_states" ("org_id", "capability_key", "state", "expires_at");

CREATE TABLE IF NOT EXISTS "hivemind"."runtime_performance_metrics" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "org_id" uuid NOT NULL,
  "run_id" uuid, "stage_id" varchar(120), "metric" varchar(120) NOT NULL,
  "value" double precision NOT NULL, "unit" varchar(24) NOT NULL,
  "source" varchar(120) NOT NULL, "metadata" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "runtime_performance_metrics_metric_idx"
  ON "hivemind"."runtime_performance_metrics" ("org_id", "metric", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "runtime_performance_metrics_run_idx"
  ON "hivemind"."runtime_performance_metrics" ("run_id", "stage_id");

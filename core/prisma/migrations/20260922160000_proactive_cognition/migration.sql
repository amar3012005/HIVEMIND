-- A reusable, default-off trigger substrate for HIVE-MIND proactive cognition.
-- Core/Postgres owns consent, policy, durable evidence, and delivery receipts;
-- Cloudflare Workflows carries only opaque schedule identifiers.

CREATE TABLE IF NOT EXISTS "hivemind"."proactive_trigger_registry" (
  "trigger_key" varchar(120) PRIMARY KEY,
  "version" integer NOT NULL DEFAULT 1,
  "enabled" boolean NOT NULL DEFAULT false,
  "description" text NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now()
);

INSERT INTO "hivemind"."proactive_trigger_registry" ("trigger_key", "version", "enabled", "description")
VALUES ('decision_reflection.v1', 1, false, 'Six-hour bounded activity reflection; explicit per-user opt-in required.')
ON CONFLICT ("trigger_key") DO NOTHING;

CREATE TABLE IF NOT EXISTS "hivemind"."proactive_user_schedules" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "hivemind"."users"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "hivemind"."organizations"("id") ON DELETE CASCADE,
  "trigger_key" varchar(120) NOT NULL REFERENCES "hivemind"."proactive_trigger_registry"("trigger_key") ON DELETE RESTRICT,
  "enabled" boolean NOT NULL DEFAULT false,
  "timezone" varchar(64) NOT NULL DEFAULT 'UTC',
  "quiet_start_hour" integer NOT NULL DEFAULT 21 CHECK ("quiet_start_hour" BETWEEN 0 AND 23),
  "quiet_end_hour" integer NOT NULL DEFAULT 8 CHECK ("quiet_end_hour" BETWEEN 0 AND 23),
  "next_evaluate_at" timestamptz,
  "last_evaluated_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "proactive_user_schedules_identity_trigger_unique" UNIQUE ("user_id", "org_id", "trigger_key")
);
CREATE INDEX IF NOT EXISTS "proactive_user_schedules_due_idx"
  ON "hivemind"."proactive_user_schedules" ("next_evaluate_at") WHERE "enabled" = true;

CREATE TABLE IF NOT EXISTS "hivemind"."proactive_evaluations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "schedule_id" uuid NOT NULL REFERENCES "hivemind"."proactive_user_schedules"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "hivemind"."users"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "hivemind"."organizations"("id") ON DELETE CASCADE,
  "trigger_key" varchar(120) NOT NULL,
  "window_start" timestamptz NOT NULL,
  "window_end" timestamptz NOT NULL,
  "mode" varchar(24) NOT NULL,
  "status" varchar(32) NOT NULL,
  "activity" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "decision" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "policy_version" varchar(120) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "proactive_evaluations_schedule_created_idx"
  ON "hivemind"."proactive_evaluations" ("schedule_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "proactive_evaluations_org_created_idx"
  ON "hivemind"."proactive_evaluations" ("org_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "hivemind"."proactive_delivery_ledger" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "schedule_id" uuid NOT NULL REFERENCES "hivemind"."proactive_user_schedules"("id") ON DELETE CASCADE,
  "evaluation_id" uuid NOT NULL REFERENCES "hivemind"."proactive_evaluations"("id") ON DELETE RESTRICT,
  "user_id" uuid NOT NULL REFERENCES "hivemind"."users"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "hivemind"."organizations"("id") ON DELETE CASCADE,
  "trigger_key" varchar(120) NOT NULL,
  "window_end" timestamptz NOT NULL,
  "policy_version" varchar(120) NOT NULL,
  "idempotency_key" char(64) NOT NULL,
  "status" varchar(32) NOT NULL,
  "focus_title" varchar(180),
  "provider" varchar(80),
  "provider_message_id" varchar(255),
  "failure_reason" varchar(240),
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz,
  CONSTRAINT "proactive_delivery_ledger_window_unique" UNIQUE ("schedule_id", "window_end", "policy_version"),
  CONSTRAINT "proactive_delivery_ledger_idempotency_unique" UNIQUE ("idempotency_key")
);
CREATE INDEX IF NOT EXISTS "proactive_delivery_ledger_user_created_idx"
  ON "hivemind"."proactive_delivery_ledger" ("user_id", "created_at" DESC);

CREATE TABLE IF NOT EXISTS "hivemind"."proactive_feedback" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "delivery_id" uuid NOT NULL REFERENCES "hivemind"."proactive_delivery_ledger"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "hivemind"."users"("id") ON DELETE CASCADE,
  "org_id" uuid NOT NULL REFERENCES "hivemind"."organizations"("id") ON DELETE CASCADE,
  "action" varchar(32) NOT NULL,
  "note" varchar(500),
  "created_at" timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "proactive_feedback_delivery_created_idx"
  ON "hivemind"."proactive_feedback" ("delivery_id", "created_at" DESC);

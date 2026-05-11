-- ============================================================
-- Migration: Digital Employees (SlackAgents + AgentScope)
-- Tables:
--   digital_employees — autonomous AI agent records
--   slack_events      — inbound event audit + replay
--   action_intents    — outbound action audit + approval queue
-- ============================================================

-- ── digital_employees ──────────────────────────────────────
CREATE TABLE "digital_employees" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "team_id" UUID,
    "name" VARCHAR(100) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "avatar_url" TEXT,
    "persona" TEXT NOT NULL,
    "model" VARCHAR(100) NOT NULL DEFAULT 'claude-haiku-4-5',
    "llm_provider" VARCHAR(50) NOT NULL DEFAULT 'anthropic',
    "hivemind_api_key_id" UUID,
    "scope" VARCHAR(20) NOT NULL DEFAULT 'team',
    "slack_team_id" VARCHAR(64),
    "slack_bot_user_id" VARCHAR(64),
    "slack_channels_allowed" TEXT[] NOT NULL DEFAULT '{}',
    "tools" TEXT[] NOT NULL DEFAULT '{}',
    "policy_rules" JSONB NOT NULL DEFAULT '{}',
    "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
    "replicas" INTEGER NOT NULL DEFAULT 1,
    "max_replicas" INTEGER NOT NULL DEFAULT 3,
    "metrics_last_24h" JSONB,
    "last_active_at" TIMESTAMPTZ,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,
    CONSTRAINT "digital_employees_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "digital_employees_org_id_slug_key" ON "digital_employees"("org_id", "slug");
CREATE INDEX "digital_employees_org_id_idx"     ON "digital_employees"("org_id");
CREATE INDEX "digital_employees_status_idx"     ON "digital_employees"("status");
CREATE INDEX "digital_employees_slack_team_idx" ON "digital_employees"("slack_team_id");

ALTER TABLE "digital_employees"
    ADD CONSTRAINT "digital_employees_org_id_fkey"
    FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "digital_employees"
    ADD CONSTRAINT "digital_employees_team_id_fkey"
    FOREIGN KEY ("team_id") REFERENCES "teams"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;

ALTER TABLE "digital_employees"
    ADD CONSTRAINT "digital_employees_created_by_fkey"
    FOREIGN KEY ("created_by") REFERENCES "users"("id")
    ON DELETE NO ACTION ON UPDATE NO ACTION;

-- Optional FK to api_keys (table exists)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'api_keys') THEN
    BEGIN
      ALTER TABLE "digital_employees"
        ADD CONSTRAINT "digital_employees_hivemind_api_key_id_fkey"
        FOREIGN KEY ("hivemind_api_key_id") REFERENCES "api_keys"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END$$;

-- ── slack_events ───────────────────────────────────────────
CREATE TABLE "slack_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "slack_event_id" VARCHAR(64) NOT NULL,
    "workspace_id" VARCHAR(64) NOT NULL,
    "channel_id" VARCHAR(64),
    "ts" VARCHAR(64) NOT NULL,
    "event_type" VARCHAR(64) NOT NULL,
    "event_subtype" VARCHAR(64),
    "routed_to_employee_id" UUID,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error_message" TEXT,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    CONSTRAINT "slack_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "slack_events_slack_event_id_key" ON "slack_events"("slack_event_id");
CREATE INDEX "slack_events_workspace_channel_idx"   ON "slack_events"("workspace_id", "channel_id");
CREATE INDEX "slack_events_status_created_idx"      ON "slack_events"("status", "created_at");
CREATE INDEX "slack_events_routed_to_employee_idx"  ON "slack_events"("routed_to_employee_id");

ALTER TABLE "slack_events"
    ADD CONSTRAINT "slack_events_routed_to_employee_id_fkey"
    FOREIGN KEY ("routed_to_employee_id") REFERENCES "digital_employees"("id")
    ON DELETE SET NULL ON UPDATE NO ACTION;

-- ── action_intents ─────────────────────────────────────────
CREATE TABLE "action_intents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "action_type" VARCHAR(64) NOT NULL,
    "payload" JSONB NOT NULL,
    "status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "deny_reason" TEXT,
    "approved_by" UUID,
    "executed_at" TIMESTAMPTZ,
    "result" JSONB,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "action_intents_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "action_intents_employee_created_idx" ON "action_intents"("employee_id", "created_at" DESC);
CREATE INDEX "action_intents_status_idx"           ON "action_intents"("status");

ALTER TABLE "action_intents"
    ADD CONSTRAINT "action_intents_employee_id_fkey"
    FOREIGN KEY ("employee_id") REFERENCES "digital_employees"("id")
    ON DELETE CASCADE ON UPDATE NO ACTION;

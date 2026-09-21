-- Governed Routine wrapper around an AgentScope native schedule.
-- AgentScope owns the timer/session; HIVE owns this identity, policy, and
-- fire idempotency projection.
CREATE TABLE IF NOT EXISTS "hivemind"."agentscope_routines" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "employee_id" UUID,
  "agent_id" VARCHAR(180) NOT NULL,
  "native_schedule_id" VARCHAR(180),
  "goal" TEXT NOT NULL,
  "playbook_id" VARCHAR(120) NOT NULL,
  "playbook_version" INTEGER NOT NULL,
  "schedule_type" VARCHAR(24) NOT NULL,
  "schedule_expression" VARCHAR(160) NOT NULL,
  "timezone" VARCHAR(80) NOT NULL DEFAULT 'UTC',
  "status" VARCHAR(24) NOT NULL DEFAULT 'active',
  "authority_policy" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "chat_model_config" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "last_fire_key" VARCHAR(240),
  "last_run_id" UUID,
  "last_run_at" TIMESTAMPTZ(6),
  "created_by" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS "hivemind"."agentscope_routine_fires" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "routine_id" UUID NOT NULL REFERENCES "hivemind"."agentscope_routines"("id") ON DELETE CASCADE,
  "fire_key" VARCHAR(240) NOT NULL,
  "work_run_id" UUID,
  "status" VARCHAR(24) NOT NULL DEFAULT 'claimed',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("routine_id", "fire_key")
);
CREATE INDEX IF NOT EXISTS "agentscope_routine_fires_routine_created_idx"
  ON "hivemind"."agentscope_routine_fires" ("routine_id", "created_at" DESC);

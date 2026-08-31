ALTER TABLE "hivemind"."hyper_turns"
  ADD COLUMN IF NOT EXISTS "control_state" JSONB NOT NULL DEFAULT '{"action":"run","revision":0}'::jsonb,
  ADD COLUMN IF NOT EXISTS "steering_messages" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE TABLE IF NOT EXISTS "hivemind"."hyper_agent_skill_versions" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "org_id" UUID NOT NULL,
  "skill_key" VARCHAR(120) NOT NULL, "version" INTEGER NOT NULL DEFAULT 1,
  "status" VARCHAR(24) NOT NULL DEFAULT 'draft', "manifest" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "validation_receipts" JSONB NOT NULL DEFAULT '[]'::jsonb, "created_by" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(), "activated_at" TIMESTAMPTZ(6),
  UNIQUE ("org_id", "skill_key", "version")
);
CREATE INDEX IF NOT EXISTS "hyper_agent_skill_versions_org_status_idx"
  ON "hivemind"."hyper_agent_skill_versions" ("org_id", "status");

CREATE TABLE IF NOT EXISTS "hivemind"."hyper_agent_routines" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "org_id" UUID NOT NULL,
  "room_id" UUID NOT NULL, "agent_runtime_id" UUID NOT NULL REFERENCES "hivemind"."hyper_agent_runtimes"("id") ON DELETE CASCADE,
  "playbook_id" VARCHAR(120) NOT NULL, "playbook_version" INTEGER NOT NULL,
  "schedule_type" VARCHAR(24) NOT NULL, "schedule_expression" VARCHAR(160) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'active', "authority_policy" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "workflow_instance_id" VARCHAR(180), "next_run_at" TIMESTAMPTZ(6), "last_run_at" TIMESTAMPTZ(6),
  "created_by" UUID NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("org_id", "room_id", "playbook_id", "playbook_version", "schedule_expression")
);
CREATE INDEX IF NOT EXISTS "hyper_agent_routines_org_status_next_idx"
  ON "hivemind"."hyper_agent_routines" ("org_id", "status", "next_run_at");

CREATE TABLE IF NOT EXISTS "hivemind"."hyper_tool_receipts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "org_id" UUID NOT NULL,
  "room_id" UUID NOT NULL, "turn_id" UUID NOT NULL, "work_order_id" UUID NOT NULL,
  "agent_instance_id" VARCHAR(180) NOT NULL, "action_key" VARCHAR(160) NOT NULL,
  "adapter" VARCHAR(80) NOT NULL, "status" VARCHAR(24) NOT NULL,
  "provider_receipt" JSONB NOT NULL DEFAULT '{}'::jsonb, "artifact_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(), UNIQUE ("org_id", "action_key")
);
CREATE INDEX IF NOT EXISTS "hyper_tool_receipts_work_status_idx"
  ON "hivemind"."hyper_tool_receipts" ("work_order_id", "status");

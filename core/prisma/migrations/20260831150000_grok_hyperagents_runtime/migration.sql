ALTER TABLE "hivemind"."hyper_turns"
  ADD COLUMN IF NOT EXISTS "grok_runtime_mode" VARCHAR(32) NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS "grok_runtime_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS "grok_workflow_instance_id" VARCHAR(180),
  ADD COLUMN IF NOT EXISTS "active_agents" JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE "hivemind"."hyper_work_orders"
  ADD COLUMN IF NOT EXISTS "agent_instance_id" VARCHAR(180),
  ADD COLUMN IF NOT EXISTS "workflow_instance_id" VARCHAR(180),
  ADD COLUMN IF NOT EXISTS "runtime_mode" VARCHAR(32) NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS "processing_version" INTEGER NOT NULL DEFAULT 1;

CREATE TABLE IF NOT EXISTS "hivemind"."hyper_agent_runtimes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "employee_id" UUID NOT NULL UNIQUE REFERENCES "hivemind"."digital_employees"("id") ON DELETE CASCADE,
  "agent_instance_id" VARCHAR(180) NOT NULL UNIQUE,
  "processing_version" INTEGER NOT NULL DEFAULT 1,
  "status" VARCHAR(24) NOT NULL DEFAULT 'idle',
  "capability_manifest" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "preferences" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "current_assignments" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "last_heartbeat_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "hyper_agent_runtimes_org_employee_key" UNIQUE ("org_id", "employee_id")
);

CREATE INDEX IF NOT EXISTS "hyper_agent_runtimes_org_status_idx"
  ON "hivemind"."hyper_agent_runtimes" ("org_id", "status");
CREATE INDEX IF NOT EXISTS "hyper_work_orders_agent_status_idx"
  ON "hivemind"."hyper_work_orders" ("agent_instance_id", "status");

CREATE OR REPLACE FUNCTION "hivemind"."prevent_grok_runtime_reseat"()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.grok_runtime_mode <> 'off' AND NEW.grok_runtime_mode <> OLD.grok_runtime_mode THEN
    RAISE EXCEPTION 'grok runtime mode is immutable after admission';
  END IF;
  IF OLD.grok_workflow_instance_id IS NOT NULL
     AND NEW.grok_workflow_instance_id IS DISTINCT FROM OLD.grok_workflow_instance_id THEN
    RAISE EXCEPTION 'grok workflow instance is immutable after admission';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS "hyper_turn_grok_runtime_latch" ON "hivemind"."hyper_turns";
CREATE TRIGGER "hyper_turn_grok_runtime_latch"
BEFORE UPDATE ON "hivemind"."hyper_turns"
FOR EACH ROW EXECUTE FUNCTION "hivemind"."prevent_grok_runtime_reseat"();

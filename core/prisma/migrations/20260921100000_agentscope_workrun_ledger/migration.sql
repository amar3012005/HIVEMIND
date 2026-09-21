-- Durable control-plane projection for one AgentScope-backed room turn.
-- AgentScope owns session/task execution; HIVE owns identity, lifecycle and
-- evidence references.  This table is intentionally distinct from
-- hyper_work_orders, which are internal room-pipeline steps.
CREATE TABLE IF NOT EXISTS "hivemind"."work_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "room_id" UUID,
  "turn_id" UUID,
  "goal" TEXT NOT NULL,
  "status" VARCHAR(32) NOT NULL DEFAULT 'queued',
  "agentscope_session_id" VARCHAR(120),
  "workspace_id" VARCHAR(160),
  "playbook_id" VARCHAR(120),
  "playbook_version" VARCHAR(40),
  "scope" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "events" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "result_artifact_ids" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "result" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "heartbeat_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "work_runs_user_created_idx"
  ON "hivemind"."work_runs" ("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "work_runs_org_status_idx"
  ON "hivemind"."work_runs" ("org_id", "status");
CREATE INDEX IF NOT EXISTS "work_runs_status_heartbeat_idx"
  ON "hivemind"."work_runs" ("status", "heartbeat_at");
CREATE UNIQUE INDEX IF NOT EXISTS "work_runs_turn_id_key"
  ON "hivemind"."work_runs" ("turn_id");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'work_runs_turn_id_fkey') THEN
    ALTER TABLE "hivemind"."work_runs"
      ADD CONSTRAINT "work_runs_turn_id_fkey"
      FOREIGN KEY ("turn_id") REFERENCES "hivemind"."hyper_turns"("id")
      ON DELETE SET NULL;
  END IF;
END $$;

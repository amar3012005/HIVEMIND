CREATE TABLE IF NOT EXISTS "hivemind"."visual_intelligence_runs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL, "user_id" UUID NOT NULL, "job_id" UUID NOT NULL,
  "room_id" UUID, "workflow_instance_id" VARCHAR(140) UNIQUE,
  "processing_version" INTEGER NOT NULL, "mode" VARCHAR(32) NOT NULL, "browser_session" VARCHAR(40),
  "deliverable" VARCHAR(64) NOT NULL, "status" VARCHAR(24) NOT NULL DEFAULT 'running',
  "current_stage" VARCHAR(48), "progress" INTEGER NOT NULL DEFAULT 0,
  "urls" JSONB NOT NULL DEFAULT '[]'::jsonb, "latched_flags" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "source_refs" JSONB NOT NULL DEFAULT '[]'::jsonb, "artifact" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "error" JSONB, "terminal_reason" VARCHAR(180), "heartbeat_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(), "finished_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("org_id", "job_id", "processing_version")
);
CREATE INDEX IF NOT EXISTS "visual_intelligence_runs_org_user_created_idx" ON "hivemind"."visual_intelligence_runs" ("org_id", "user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "visual_intelligence_runs_status_heartbeat_idx" ON "hivemind"."visual_intelligence_runs" ("status", "heartbeat_at");

CREATE TABLE IF NOT EXISTS "hivemind"."visual_intelligence_steps" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(), "run_id" UUID NOT NULL REFERENCES "hivemind"."visual_intelligence_runs"("id") ON DELETE CASCADE,
  "stage_key" VARCHAR(48) NOT NULL, "shard_key" VARCHAR(160) NOT NULL DEFAULT 'root', "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempt" INTEGER NOT NULL DEFAULT 0, "input_digest" VARCHAR(64) NOT NULL,
  "output_receipt" JSONB NOT NULL DEFAULT '{}'::jsonb, "counters" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "lease_expires_at" TIMESTAMPTZ(6), "error" JSONB, "started_at" TIMESTAMPTZ(6), "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(), "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  UNIQUE ("run_id", "stage_key", "shard_key")
);
CREATE INDEX IF NOT EXISTS "visual_intelligence_steps_status_lease_idx" ON "hivemind"."visual_intelligence_steps" ("status", "lease_expires_at");

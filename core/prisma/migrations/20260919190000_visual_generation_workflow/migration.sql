CREATE TABLE IF NOT EXISTS "hivemind"."visual_generation_jobs" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "room_id" UUID,
  "campaign_id" UUID,
  "action_id" UUID,
  "idempotency_key" VARCHAR(180) NOT NULL,
  "workflow_instance_id" VARCHAR(180),
  "contract_version" VARCHAR(48) NOT NULL DEFAULT 'visual.production.v1',
  "instruction" TEXT NOT NULL,
  "use_case" VARCHAR(64) NOT NULL,
  "output_mode" VARCHAR(16) NOT NULL,
  "requested_count" INTEGER NOT NULL,
  "aspect_ratios" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "quality" VARCHAR(24) NOT NULL DEFAULT 'quality',
  "model_policy" VARCHAR(32) NOT NULL DEFAULT 'auto',
  "source" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
  "current_stage" VARCHAR(48) NOT NULL DEFAULT 'queued',
  "progress" INTEGER NOT NULL DEFAULT 0,
  "brand_dna_ref" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "company_context" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "production_spec" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "assets" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "error" JSONB,
  "terminal_reason" VARCHAR(180),
  "heartbeat_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6),
  "finished_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "visual_generation_jobs_org_user_idempotency_key" ON "hivemind"."visual_generation_jobs" ("org_id", "user_id", "idempotency_key");
CREATE UNIQUE INDEX IF NOT EXISTS "visual_generation_jobs_workflow_instance_id_key" ON "hivemind"."visual_generation_jobs" ("workflow_instance_id");
CREATE INDEX IF NOT EXISTS "visual_generation_jobs_org_user_created_idx" ON "hivemind"."visual_generation_jobs" ("org_id", "user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "visual_generation_jobs_status_heartbeat_idx" ON "hivemind"."visual_generation_jobs" ("status", "heartbeat_at");

CREATE TABLE IF NOT EXISTS "hivemind"."visual_generation_events" (
  "id" BIGSERIAL PRIMARY KEY,
  "job_id" UUID NOT NULL REFERENCES "hivemind"."visual_generation_jobs"("id") ON DELETE CASCADE,
  "event_key" VARCHAR(120) NOT NULL,
  "stage" VARCHAR(48) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "progress" INTEGER NOT NULL,
  "message" VARCHAR(300) NOT NULL,
  "data" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX IF NOT EXISTS "visual_generation_events_job_event_key" ON "hivemind"."visual_generation_events" ("job_id", "event_key");
CREATE INDEX IF NOT EXISTS "visual_generation_events_job_id_id_idx" ON "hivemind"."visual_generation_events" ("job_id", "id");

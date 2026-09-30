-- Hyper Agents' private operating memory. This is deliberately outside the
-- company memories table: it is not exposed by public recall, profiles, or
-- the company-brain approval/promotion pipeline.
CREATE TABLE IF NOT EXISTS "hivemind"."hyper_agent_operating_memories" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "project_id" UUID NOT NULL REFERENCES "hivemind"."projects"("id") ON DELETE CASCADE,
  "project_slug" VARCHAR(120) NOT NULL DEFAULT 'hyper-agents',
  "idempotency_key" VARCHAR(200) NOT NULL,
  "kind" VARCHAR(40) NOT NULL,
  "status" VARCHAR(24) NOT NULL,
  "agent_slug" VARCHAR(120) NOT NULL,
  "author_user_id" UUID NOT NULL,
  "room_id" UUID,
  "run_id" VARCHAR(80),
  "trigger_id" UUID,
  "title" VARCHAR(180) NOT NULL,
  "summary" TEXT NOT NULL,
  "context" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "hyper_agent_operating_memories_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hyper_agent_operating_memories_project_check" CHECK ("project_slug" = 'hyper-agents'),
  CONSTRAINT "hyper_agent_operating_memories_kind_check" CHECK ("kind" IN ('learning', 'decision_note', 'handoff', 'task_status', 'trigger_status')),
  CONSTRAINT "hyper_agent_operating_memories_status_check" CHECK ("status" IN ('recorded', 'active', 'completed', 'incomplete', 'errored', 'paused')),
  CONSTRAINT "hyper_agent_operating_memories_org_key" UNIQUE ("org_id", "idempotency_key")
);
CREATE INDEX IF NOT EXISTS "hyper_agent_operating_memories_recent_idx"
  ON "hivemind"."hyper_agent_operating_memories" ("org_id", "created_at" DESC, "id" DESC);
CREATE INDEX IF NOT EXISTS "hyper_agent_operating_memories_filter_idx"
  ON "hivemind"."hyper_agent_operating_memories" ("org_id", "kind", "agent_slug", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "hyper_agent_operating_memories_run_idx"
  ON "hivemind"."hyper_agent_operating_memories" ("org_id", "run_id") WHERE "run_id" IS NOT NULL;

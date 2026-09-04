CREATE TABLE IF NOT EXISTS "agent_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "conversation_id" varchar(160) NOT NULL,
  "goal" text NOT NULL,
  "composio_session_id" varchar(160),
  "status" varchar(32) NOT NULL DEFAULT 'running',
  "steps" jsonb NOT NULL DEFAULT '[]',
  "scratch" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "agent_runs_org_conversation_key" ON "agent_runs" ("org_id", "conversation_id");
CREATE INDEX IF NOT EXISTS "agent_runs_org_user_updated_idx" ON "agent_runs" ("org_id", "user_id", "updated_at" DESC);

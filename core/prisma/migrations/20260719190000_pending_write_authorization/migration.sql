-- Some long-lived production databases predate the original draft table
-- migration. Create the legacy shape first so this authorization migration is
-- self-contained and safe to apply on both histories.
CREATE TABLE IF NOT EXISTS "pending_writes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" UUID NOT NULL,
  "org_id" UUID,
  "provider" VARCHAR(50) NOT NULL,
  "tool_name" VARCHAR(120) NOT NULL,
  "tool_args" JSONB NOT NULL,
  "preview" TEXT,
  "status" VARCHAR(20) NOT NULL DEFAULT 'draft',
  "result" JSONB,
  "error_msg" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  "approved_at" TIMESTAMPTZ(6),
  "sent_at" TIMESTAMPTZ(6)
);

ALTER TABLE "pending_writes"
  ADD COLUMN IF NOT EXISTS "tool_group" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "args_hash" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "project_id" UUID,
  ADD COLUMN IF NOT EXISTS "connection_id" VARCHAR(160),
  ADD COLUMN IF NOT EXISTS "trace_id" VARCHAR(160),
  ADD COLUMN IF NOT EXISTS "idempotency_key" VARCHAR(160),
  ADD COLUMN IF NOT EXISTS "expires_at" TIMESTAMPTZ(6);

CREATE UNIQUE INDEX IF NOT EXISTS "pending_writes_idempotency_key_key"
  ON "pending_writes"("idempotency_key");
CREATE INDEX IF NOT EXISTS "pending_writes_org_id_status_expires_at_idx"
  ON "pending_writes"("org_id", "status", "expires_at");
CREATE INDEX IF NOT EXISTS "pending_writes_user_status_created_idx"
  ON "pending_writes"("user_id", "status", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "pending_writes_org_created_idx"
  ON "pending_writes"("org_id", "created_at" DESC);

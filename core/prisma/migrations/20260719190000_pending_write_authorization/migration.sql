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

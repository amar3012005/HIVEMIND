CREATE TABLE IF NOT EXISTS "hivemind"."memory_write_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "idempotency_key" VARCHAR(180) NOT NULL,
  "request_hash" CHAR(64) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'processing',
  "memory_id" UUID,
  "response" JSONB,
  "error_code" VARCHAR(80),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "memory_write_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "memory_write_receipts_status_check" CHECK ("status" IN ('processing', 'saved', 'failed')),
  CONSTRAINT "memory_write_receipts_memory_fkey" FOREIGN KEY ("memory_id") REFERENCES "hivemind"."memories"("id") ON DELETE SET NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "memory_write_receipts_owner_key"
  ON "hivemind"."memory_write_receipts"("org_id", "user_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "memory_write_receipts_updated_idx"
  ON "hivemind"."memory_write_receipts"("status", "updated_at");

ALTER TABLE "hivemind"."memory_write_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "hivemind"."memory_write_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "memory_write_receipts_owner_isolation" ON "hivemind"."memory_write_receipts"
  USING (
    "org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid
  );

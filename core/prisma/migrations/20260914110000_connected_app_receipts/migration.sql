CREATE TABLE IF NOT EXISTS "connected_app_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "session_id" VARCHAR(180) NOT NULL,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "turn_id" BIGINT,
  "call_id" VARCHAR(180) NOT NULL,
  "provider" VARCHAR(80) NOT NULL,
  "tool" VARCHAR(180) NOT NULL,
  "contract_version" VARCHAR(180),
  "ciphertext" BYTEA NOT NULL,
  "nonce" BYTEA NOT NULL,
  "auth_tag" BYTEA NOT NULL,
  "allowed_fields" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "projection_policy" VARCHAR(80) NOT NULL,
  "content_hash" CHAR(64) NOT NULL,
  "content_bytes" INTEGER NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "last_read_at" TIMESTAMPTZ(6),
  CONSTRAINT "connected_app_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "connected_app_receipts_tenant_session_fkey"
    FOREIGN KEY ("session_id", "org_id", "user_id")
    REFERENCES "harness_sessions"("id", "org_id", "user_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "connected_app_receipts_session_call_key"
  ON "connected_app_receipts"("session_id", "call_id");
CREATE INDEX IF NOT EXISTS "connected_app_receipts_owner_expiry_idx"
  ON "connected_app_receipts"("org_id", "user_id", "session_id", "expires_at");
CREATE INDEX IF NOT EXISTS "connected_app_receipts_expiry_idx"
  ON "connected_app_receipts"("expires_at");

ALTER TABLE "connected_app_receipts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "connected_app_receipts" FORCE ROW LEVEL SECURITY;
CREATE POLICY "connected_app_receipts_tenant_isolation" ON "connected_app_receipts"
  USING (
    "org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid
  )
  WITH CHECK (
    "org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid
  );

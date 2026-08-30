CREATE TABLE "durable_chat_continuations" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "token_hash" CHAR(64) NOT NULL,
  "parent_turn_id" UUID,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "consumed_at" TIMESTAMPTZ(6),
  CONSTRAINT "durable_chat_continuations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "durable_chat_continuations_token_hash_key" ON "durable_chat_continuations"("token_hash");
CREATE INDEX "durable_chat_continuations_tenant_status_idx" ON "durable_chat_continuations"("org_id", "user_id", "status", "expires_at");
CREATE INDEX "durable_chat_continuations_recovery_idx" ON "durable_chat_continuations"("status", "lease_expires_at");

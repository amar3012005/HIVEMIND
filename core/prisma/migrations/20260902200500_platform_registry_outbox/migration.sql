CREATE TABLE IF NOT EXISTS "platform_registry_outbox" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "revision" BIGSERIAL NOT NULL,
  "entity_type" VARCHAR(48) NOT NULL,
  "entity_id" UUID NOT NULL,
  "operation" VARCHAR(16) NOT NULL,
  "payload" JSONB NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "delivered_at" TIMESTAMPTZ(6),
  "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "platform_registry_outbox_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "platform_registry_outbox_revision_key" ON "platform_registry_outbox"("revision");
CREATE INDEX IF NOT EXISTS "platform_registry_outbox_status_next_attempt_at_idx" ON "platform_registry_outbox"("status", "next_attempt_at");
CREATE INDEX IF NOT EXISTS "platform_registry_outbox_entity_type_entity_id_revision_idx" ON "platform_registry_outbox"("entity_type", "entity_id", "revision");

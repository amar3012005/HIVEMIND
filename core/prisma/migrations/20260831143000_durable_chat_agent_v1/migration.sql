CREATE TABLE IF NOT EXISTS "durable_chat_turns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "thread_digest" CHAR(64),
  "idempotency_key" VARCHAR(180) NOT NULL,
  "orchestration_mode" VARCHAR(24) NOT NULL DEFAULT 'off',
  "status" VARCHAR(32) NOT NULL DEFAULT 'accepted',
  "current_phase" VARCHAR(40) NOT NULL DEFAULT 'accepted',
  "request_payload" JSONB NOT NULL,
  "scope_snapshot" JSONB NOT NULL DEFAULT '{}',
  "response_payload" JSONB,
  "error" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  CONSTRAINT "durable_chat_turns_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "durable_chat_turns_org_idempotency_key" ON "durable_chat_turns"("org_id", "idempotency_key");
CREATE INDEX IF NOT EXISTS "durable_chat_turns_tenant_updated_idx" ON "durable_chat_turns"("org_id", "user_id", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "durable_chat_turns_thread_updated_idx" ON "durable_chat_turns"("thread_digest", "updated_at" DESC);

CREATE TABLE IF NOT EXISTS "durable_chat_checkpoints" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "turn_id" UUID NOT NULL,
  "phase" VARCHAR(40) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "input_digest" CHAR(64),
  "receipt" JSONB NOT NULL DEFAULT '{}',
  "error" JSONB,
  "lease_token" UUID,
  "lease_expires_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "durable_chat_checkpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "durable_chat_checkpoints_turn_fkey" FOREIGN KEY ("turn_id") REFERENCES "durable_chat_turns"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "durable_chat_checkpoints_turn_phase_key" ON "durable_chat_checkpoints"("turn_id", "phase");
CREATE INDEX IF NOT EXISTS "durable_chat_checkpoints_recovery_idx" ON "durable_chat_checkpoints"("status", "lease_expires_at");

CREATE TABLE IF NOT EXISTS "durable_chat_events" (
  "id" BIGSERIAL NOT NULL,
  "turn_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "event_type" VARCHAR(80) NOT NULL,
  "event" JSONB NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "durable_chat_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "durable_chat_events_turn_fkey" FOREIGN KEY ("turn_id") REFERENCES "durable_chat_turns"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "durable_chat_events_turn_sequence_key" ON "durable_chat_events"("turn_id", "sequence");
CREATE INDEX IF NOT EXISTS "durable_chat_events_turn_created_idx" ON "durable_chat_events"("turn_id", "created_at");

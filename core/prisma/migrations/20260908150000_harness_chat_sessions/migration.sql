CREATE TABLE IF NOT EXISTS "harness_sessions" (
  "id" VARCHAR(180) NOT NULL,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "project_id" UUID,
  "profile" VARCHAR(64) NOT NULL DEFAULT 'hivemind-chat',
  "variation" VARCHAR(16) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'active',
  "header" JSONB NOT NULL DEFAULT '{}',
  "title" VARCHAR(500),
  "revision" BIGINT NOT NULL DEFAULT 0,
  "inherited_event_count" BIGINT NOT NULL DEFAULT 0,
  "event_count" BIGINT NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closed_at" TIMESTAMPTZ(6),
  CONSTRAINT "harness_sessions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "harness_sessions_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE NO ACTION,
  CONSTRAINT "harness_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "harness_sessions_tenant_identity_key" ON "harness_sessions"("id", "org_id", "user_id");
CREATE INDEX IF NOT EXISTS "harness_sessions_tenant_updated_idx" ON "harness_sessions"("org_id", "user_id", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "harness_sessions_status_updated_idx" ON "harness_sessions"("status", "updated_at" DESC);
CREATE INDEX IF NOT EXISTS "harness_sessions_project_updated_idx" ON "harness_sessions"("org_id", "project_id", "updated_at" DESC);

CREATE TABLE IF NOT EXISTS "harness_session_events" (
  "id" BIGSERIAL NOT NULL,
  "session_id" VARCHAR(180) NOT NULL,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "sequence" BIGINT NOT NULL,
  "event_type" VARCHAR(80) NOT NULL,
  -- Exact native Harness SessionEvent envelope. sequence/event_type/created_at
  -- are duplicated indexed projections and must match this JSON value.
  "payload" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "harness_session_events_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "harness_session_events_tenant_session_fkey" FOREIGN KEY ("session_id", "org_id", "user_id") REFERENCES "harness_sessions"("id", "org_id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "harness_session_events_session_sequence_key" ON "harness_session_events"("session_id", "sequence");
CREATE INDEX IF NOT EXISTS "harness_session_events_session_created_idx" ON "harness_session_events"("session_id", "created_at");
CREATE INDEX IF NOT EXISTS "harness_session_events_tenant_created_idx" ON "harness_session_events"("org_id", "user_id", "created_at");

-- Exactly one writer-coordination row exists per session. Acquisition locks
-- this row and increments fencing_token before replacing its holder and expiry.
CREATE TABLE IF NOT EXISTS "harness_session_leases" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "session_id" VARCHAR(180) NOT NULL,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "holder_id" TEXT NOT NULL,
  "token_hash" CHAR(64) NOT NULL,
  "fencing_token" BIGINT NOT NULL DEFAULT 0,
  "acquired_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "heartbeat_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "released_at" TIMESTAMPTZ(6),
  CONSTRAINT "harness_session_leases_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "harness_session_leases_tenant_session_fkey" FOREIGN KEY ("session_id", "org_id", "user_id") REFERENCES "harness_sessions"("id", "org_id", "user_id") ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS "harness_session_leases_session_key" ON "harness_session_leases"("session_id");
CREATE UNIQUE INDEX IF NOT EXISTS "harness_session_leases_token_hash_key" ON "harness_session_leases"("token_hash");
CREATE INDEX IF NOT EXISTS "harness_session_leases_recovery_idx" ON "harness_session_leases"("expires_at");
CREATE INDEX IF NOT EXISTS "harness_session_leases_tenant_expiry_idx" ON "harness_session_leases"("org_id", "user_id", "expires_at");

ALTER TABLE "harness_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "harness_sessions" FORCE ROW LEVEL SECURITY;
ALTER TABLE "harness_session_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "harness_session_events" FORCE ROW LEVEL SECURITY;
ALTER TABLE "harness_session_leases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "harness_session_leases" FORCE ROW LEVEL SECURITY;

CREATE POLICY "harness_sessions_tenant_isolation" ON "harness_sessions"
  USING ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);
CREATE POLICY "harness_session_events_tenant_isolation" ON "harness_session_events"
  USING ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);
CREATE POLICY "harness_session_leases_tenant_isolation" ON "harness_session_leases"
  USING ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);

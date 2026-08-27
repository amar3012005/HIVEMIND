CREATE TABLE IF NOT EXISTS "memory_box_connections" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "box_id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "transport" VARCHAR(32) NOT NULL DEFAULT 'custom_https',
  "endpoint" TEXT,
  "credential_hash" VARCHAR(64),
  "credential_version" INTEGER NOT NULL DEFAULT 1,
  "state" VARCHAR(32) NOT NULL DEFAULT 'REGISTERED',
  "desired_release" VARCHAR(120),
  "observed_release" VARCHAR(120),
  "protocol_version" VARCHAR(64),
  "schema_version" INTEGER,
  "capabilities" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "tunnel_id" VARCHAR(64),
  "last_heartbeat_at" TIMESTAMPTZ(6),
  "last_reachable_at" TIMESTAMPTZ(6),
  "consecutive_failures" INTEGER NOT NULL DEFAULT 0,
  "metadata" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "registered_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_box_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "memory_box_connections_org_id_key" ON "memory_box_connections"("org_id");
CREATE UNIQUE INDEX IF NOT EXISTS "memory_box_connections_box_id_key" ON "memory_box_connections"("box_id");
CREATE INDEX IF NOT EXISTS "memory_box_connections_state_heartbeat_idx" ON "memory_box_connections"("state", "last_heartbeat_at");

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'memory_box_connections_org_id_fkey') THEN
    ALTER TABLE "memory_box_connections" ADD CONSTRAINT "memory_box_connections_org_id_fkey"
      FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

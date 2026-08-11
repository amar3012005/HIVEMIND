-- Connector Runtime V1 — durable sync job (plan §7). Postgres becomes the job
-- source of truth (replacing the file-backed MCPConnectorJobStore). Additive:
-- a new table, no change to existing objects. Lease via SKIP LOCKED.
CREATE TABLE IF NOT EXISTS hivemind.connector_sync_jobs (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id                      UUID NOT NULL,
  user_id                     UUID NOT NULL,
  connector_id                VARCHAR(120) NOT NULL,
  connection_id               VARCHAR(160),
  mode                        VARCHAR(20) NOT NULL DEFAULT 'incremental',  -- initial | incremental | webhook
  status                      VARCHAR(20) NOT NULL DEFAULT 'queued',       -- queued|leased|running|completed|failed|cancelled|reauth_required
  cursor                      TEXT,
  requested_scope             VARCHAR(20),
  project_ids                 UUID[] DEFAULT '{}',
  processed                   INTEGER NOT NULL DEFAULT 0,
  imported                    INTEGER NOT NULL DEFAULT 0,
  skipped                     INTEGER NOT NULL DEFAULT 0,
  failed                      INTEGER NOT NULL DEFAULT 0,
  attempt                     INTEGER NOT NULL DEFAULT 0,
  max_attempts                INTEGER NOT NULL DEFAULT 5,
  lease_owner                 VARCHAR(160),
  lease_expires_at            TIMESTAMPTZ,
  idempotency_key             VARCHAR(200) UNIQUE,     -- org+connection+mode+key
  started_at                  TIMESTAMPTZ,
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at                TIMESTAMPTZ,
  cancellation_requested_at   TIMESTAMPTZ,
  last_error                  TEXT,
  config                      JSONB,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_connector_sync_jobs_lease
  ON hivemind.connector_sync_jobs(status, lease_expires_at);
CREATE INDEX IF NOT EXISTS idx_connector_sync_jobs_org
  ON hivemind.connector_sync_jobs(org_id, connector_id, created_at DESC);

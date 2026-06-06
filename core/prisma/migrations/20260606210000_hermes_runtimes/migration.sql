-- Phase 6b — hm-hermes-manager runtime registry.
-- Additive + idempotent. One row per tenant Hermes runtime. Accessed via raw SQL
-- (retrieval-config.js pattern) so no prisma schema/client change is needed and
-- prod schema.prisma drift is never touched. Backward-compatible; no down-migrate.
CREATE TABLE IF NOT EXISTS hivemind.hermes_runtimes (
  tenant_id        text PRIMARY KEY,
  container_name   text NOT NULL,
  image            text NOT NULL DEFAULT 'nousresearch/hermes-agent:latest',
  volume_name      text NOT NULL,
  gateway_port     integer NOT NULL,
  dashboard_port   integer,
  networks         text[] NOT NULL DEFAULT '{}',
  resource_limits  jsonb NOT NULL DEFAULT '{}'::jsonb,
  mcp_url          text,
  org_id           text,
  status           text NOT NULL DEFAULT 'pending',
  container_host   text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  deleted_at       timestamptz
);
CREATE INDEX IF NOT EXISTS hermes_runtimes_status_idx
  ON hivemind.hermes_runtimes (status) WHERE deleted_at IS NULL;

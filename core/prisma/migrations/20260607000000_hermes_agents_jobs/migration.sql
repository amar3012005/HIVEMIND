-- Phase 6e — hm-control /hermes/* control plane.
-- Additive, idempotent, backward-compatible (raw SQL like 20260606210000_hermes_runtimes).
-- Two tables, both tenant-scoped (org_id), no FKs into existing tables (decoupled, safe to apply on prod).

-- Per-tenant Hermes agent definitions (the roster the FE renders; config lives in Postgres).
CREATE TABLE IF NOT EXISTS hivemind.hermes_agents (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  tenant_id   text NOT NULL,
  name        text NOT NULL,
  config      jsonb NOT NULL DEFAULT '{}'::jsonb,   -- a HermesAgentConfig (validated app-side)
  status      text NOT NULL DEFAULT 'active',        -- active | paused | archived
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  deleted_at  timestamptz
);
-- Tenant-scoped list query: every read filters by org_id (CLAUDE.md: scope user data by tenant).
CREATE INDEX IF NOT EXISTS hermes_agents_org_idx
  ON hivemind.hermes_agents (org_id) WHERE deleted_at IS NULL;

-- Append-only audit of every dispatch / lifecycle action (runs, logs, approvals derive from this).
CREATE TABLE IF NOT EXISTS hivemind.hermes_jobs (
  id          text PRIMARY KEY,
  org_id      text NOT NULL,
  tenant_id   text NOT NULL,
  agent_id    text NOT NULL,
  action      text NOT NULL,                         -- run | pause | resume | approval
  status      text NOT NULL DEFAULT 'queued',        -- queued | running | succeeded | failed | awaiting_approval | approved | rejected
  payload     jsonb,
  result      jsonb,
  created_by  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hermes_jobs_agent_idx
  ON hivemind.hermes_jobs (agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hermes_jobs_org_idx
  ON hivemind.hermes_jobs (org_id, created_at DESC);

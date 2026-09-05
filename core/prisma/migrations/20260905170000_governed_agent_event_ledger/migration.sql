-- Canonical event ledger for the LangGraph governed-agent runtime.
-- This is additive and inert until GOVERNED_LANGGRAPH_RUNTIME is admitted.
CREATE TABLE IF NOT EXISTS hivemind.governed_agent_events (
  id varchar(80) PRIMARY KEY,
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES hivemind.agent_runs(id) ON DELETE CASCADE,
  sequence integer NOT NULL,
  type varchar(80) NOT NULL,
  causation_id varchar(160),
  idempotency_key varchar(160) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz(6) NOT NULL DEFAULT now(),
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT governed_agent_events_run_sequence_key UNIQUE (run_id, sequence),
  CONSTRAINT governed_agent_events_org_idempotency_key UNIQUE (org_id, idempotency_key)
);

CREATE INDEX IF NOT EXISTS governed_agent_events_run_lookup_idx
  ON hivemind.governed_agent_events (org_id, user_id, run_id, occurred_at);

-- Stable mapping for a user's governed Tool Router session. AgentRun retains
-- the exact session used for a particular checkpoint; this table is the
-- durable default for the next authenticated turn under the same authority
-- scope.
CREATE TABLE IF NOT EXISTS hivemind.governed_composio_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  connection_scope varchar(32) NOT NULL DEFAULT 'user',
  session_id varchar(160) NOT NULL,
  toolkits jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz(6) NOT NULL DEFAULT now(),
  updated_at timestamptz(6) NOT NULL DEFAULT now(),
  CONSTRAINT governed_composio_sessions_scope_key UNIQUE (org_id, user_id, connection_scope)
);

CREATE INDEX IF NOT EXISTS governed_composio_sessions_user_updated_idx
  ON hivemind.governed_composio_sessions (org_id, user_id, updated_at DESC);

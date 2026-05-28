-- Phase 1: Governance foundation (additive, backward-compatible)
-- Safe on existing prod: every column / table uses IF NOT EXISTS.
-- Retro-includes Phase A tier + working_sets that were ALTER'd out-of-band.

-- ─────────────────────────────────────────────────────────────
-- 1. Memory: tier + accessed timestamps (Phase A retro) + cognitive_layer_role (Phase 1)
-- ─────────────────────────────────────────────────────────────
ALTER TABLE hivemind.memories
  ADD COLUMN IF NOT EXISTS tier integer NOT NULL DEFAULT 2,
  ADD COLUMN IF NOT EXISTS last_accessed_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS promoted_at timestamptz NULL,
  ADD COLUMN IF NOT EXISTS cognitive_layer_role text NULL;

CREATE INDEX IF NOT EXISTS memories_tier_idx
  ON hivemind.memories (tier);
CREATE INDEX IF NOT EXISTS memories_user_tier_lastaccess_idx
  ON hivemind.memories (user_id, tier, last_accessed_at DESC);
CREATE INDEX IF NOT EXISTS memories_cognitive_layer_role_idx
  ON hivemind.memories (cognitive_layer_role)
  WHERE cognitive_layer_role IS NOT NULL;

-- Domain check: prevent typos at write time.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'memories_cognitive_layer_role_check'
  ) THEN
    ALTER TABLE hivemind.memories
      ADD CONSTRAINT memories_cognitive_layer_role_check
      CHECK (cognitive_layer_role IS NULL OR cognitive_layer_role IN (
        'canonical', 'bridge', 'compression', 'reflection'
      ));
  END IF;
END $$;

-- ─────────────────────────────────────────────────────────────
-- 2. working_sets (Phase A retro — already in prod, declared here)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hivemind.working_sets (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           uuid NOT NULL UNIQUE,
  org_id            uuid NULL,
  active_entities   text[] NOT NULL DEFAULT '{}',
  active_threads    text[] NOT NULL DEFAULT '{}',
  active_projects   text[] NOT NULL DEFAULT '{}',
  pinned_memory_ids uuid[] NOT NULL DEFAULT '{}',
  updated_at        timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS working_sets_org_id_idx ON hivemind.working_sets (org_id);

-- ─────────────────────────────────────────────────────────────
-- 3. governance_action_log — append-only audit of every agent mutation
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hivemind.governance_action_log (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id          uuid NOT NULL,
  agent_name        text NOT NULL,
  user_id           uuid NULL,
  org_id            uuid NOT NULL,
  target_memory_id  uuid NULL,
  action_type       text NOT NULL,
  reasoning         text NULL,
  evidence_ids      uuid[] NOT NULL DEFAULT '{}',
  confidence        real NULL,
  status            text NOT NULL DEFAULT 'proposed',
  reversible        boolean NOT NULL DEFAULT true,
  retry_count       integer NOT NULL DEFAULT 0,
  before_snapshot   jsonb NULL,
  after_snapshot    jsonb NULL,
  applied_at        timestamptz NULL,
  reverted_at       timestamptz NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT governance_action_log_status_check CHECK (status IN (
    'proposed','approved','rejected','applied','reverted','failed'
  )),
  CONSTRAINT governance_action_log_action_check CHECK (action_type IN (
    'link_update_chain',
    'merge_duplicate_cluster',
    'archive_duplicate',
    'merge_evidence',
    'suppress_noise_cluster',
    'promote_known_risk',
    'relationship_candidate',
    'canonical_synthesis',
    'bridge_synthesis',
    'compression',
    'role_assignment'
  ))
);

-- Idempotency: same target+action within a batch dedupes.
CREATE UNIQUE INDEX IF NOT EXISTS governance_action_log_idempotent_idx
  ON hivemind.governance_action_log (target_memory_id, action_type, batch_id)
  WHERE target_memory_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS governance_action_log_org_status_idx
  ON hivemind.governance_action_log (org_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS governance_action_log_batch_idx
  ON hivemind.governance_action_log (batch_id);
CREATE INDEX IF NOT EXISTS governance_action_log_agent_idx
  ON hivemind.governance_action_log (agent_name, created_at DESC);

-- ─────────────────────────────────────────────────────────────
-- 4. governance_agent_state — per-agent rolling state, budgets, cursors
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hivemind.governance_agent_state (
  agent_name             text PRIMARY KEY,
  last_run_at            timestamptz NULL,
  last_completed_at      timestamptz NULL,
  cursor_memory_id       uuid NULL,
  config                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  metrics                jsonb NOT NULL DEFAULT '{}'::jsonb,
  daily_token_budget     integer NOT NULL DEFAULT 1000000,
  tokens_spent_today     integer NOT NULL DEFAULT 0,
  token_budget_reset_at  date NOT NULL DEFAULT CURRENT_DATE,
  circuit_breaker_until  timestamptz NULL,
  updated_at             timestamptz NOT NULL DEFAULT now()
);

-- Seed canonical agents (idempotent)
INSERT INTO hivemind.governance_agent_state (agent_name)
VALUES ('faraday'), ('feynman'), ('turing')
ON CONFLICT (agent_name) DO NOTHING;

-- ─────────────────────────────────────────────────────────────
-- 5. governance_metric — daily roll-up per (agent, org)
-- ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS hivemind.governance_metric (
  agent_name         text NOT NULL,
  org_id             uuid NOT NULL,
  day                date NOT NULL,
  actions_proposed   integer NOT NULL DEFAULT 0,
  actions_approved   integer NOT NULL DEFAULT 0,
  actions_applied    integer NOT NULL DEFAULT 0,
  actions_reverted   integer NOT NULL DEFAULT 0,
  actions_rejected   integer NOT NULL DEFAULT 0,
  actions_failed     integer NOT NULL DEFAULT 0,
  tokens_spent       bigint  NOT NULL DEFAULT 0,
  latency_ms_p95     integer NULL,
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_name, org_id, day)
);
CREATE INDEX IF NOT EXISTS governance_metric_day_idx
  ON hivemind.governance_metric (day DESC, agent_name);

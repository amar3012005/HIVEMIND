-- Durable HQ Runtime foundation. Apply with the repository manual SQL procedure.
-- Do not use prisma migrate deploy in this installation.
CREATE TABLE IF NOT EXISTS hivemind.hq_runtimes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL UNIQUE,
  owner_user_id uuid NOT NULL,
  objective text NOT NULL,
  state varchar(24) NOT NULL DEFAULT 'INACTIVE',
  authority_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  active_goal_id uuid,
  active_stage_id uuid,
  current_cycle_id uuid,
  next_wake_at timestamptz,
  pause_reason text,
  blocked_reason text,
  event_sequence bigint NOT NULL DEFAULT 0,
  version integer NOT NULL DEFAULT 1,
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hivemind.hq_cycles (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id uuid NOT NULL,
  org_id uuid NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  trigger_type varchar(60) NOT NULL,
  trigger_payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  input_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'QUEUED',
  decision jsonb NOT NULL DEFAULT '{}'::jsonb,
  usage jsonb NOT NULL DEFAULT '{}'::jsonb,
  error text,
  lease_owner varchar(160),
  lease_expires_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);

CREATE TABLE IF NOT EXISTS hivemind.hq_runtime_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id uuid NOT NULL,
  cycle_id uuid,
  org_id uuid NOT NULL,
  sequence bigint NOT NULL,
  event_type varchar(60) NOT NULL,
  title varchar(240) NOT NULL,
  summary text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  skill_ref varchar(160),
  tool_ref varchar(160),
  work_order_id uuid,
  evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  visibility varchar(20) NOT NULL DEFAULT 'USER',
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (runtime_id, sequence)
);

CREATE TABLE IF NOT EXISTS hivemind.hq_schedules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id uuid NOT NULL,
  org_id uuid NOT NULL,
  idempotency_key varchar(160) NOT NULL,
  trigger_type varchar(60) NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  due_at timestamptz NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'PENDING',
  lease_owner varchar(160),
  lease_expires_at timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  last_error text,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id, idempotency_key)
);

ALTER TABLE hivemind.hyper_work_orders ADD COLUMN IF NOT EXISTS hq_cycle_id uuid;
ALTER TABLE hivemind.hyper_work_orders ADD COLUMN IF NOT EXISTS growth_delegation_id uuid;
ALTER TABLE hivemind.hyper_work_orders ALTER COLUMN turn_id DROP NOT NULL;

CREATE INDEX IF NOT EXISTS hq_runtimes_state_wake_idx ON hivemind.hq_runtimes (state, next_wake_at);
CREATE INDEX IF NOT EXISTS hq_cycles_runtime_created_idx ON hivemind.hq_cycles (runtime_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hq_cycles_status_lease_idx ON hivemind.hq_cycles (status, lease_expires_at);
CREATE INDEX IF NOT EXISTS hq_events_org_created_idx ON hivemind.hq_runtime_events (org_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hq_events_cycle_sequence_idx ON hivemind.hq_runtime_events (cycle_id, sequence);
CREATE INDEX IF NOT EXISTS hq_schedules_status_due_idx ON hivemind.hq_schedules (status, due_at);
CREATE INDEX IF NOT EXISTS hq_schedules_runtime_created_idx ON hivemind.hq_schedules (runtime_id, created_at DESC);
CREATE INDEX IF NOT EXISTS hyper_work_orders_hq_cycle_status_idx ON hivemind.hyper_work_orders (hq_cycle_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS hyper_work_orders_hq_cycle_order_key_uq
  ON hivemind.hyper_work_orders (hq_cycle_id, order_key) WHERE hq_cycle_id IS NOT NULL;

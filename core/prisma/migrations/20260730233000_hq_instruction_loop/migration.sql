-- Durable HQ instruction, todo, and capability dependency loop.
-- Apply with the repository manual SQL procedure; do not use prisma migrate deploy.
CREATE TABLE IF NOT EXISTS hivemind.hq_instructions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), runtime_id uuid NOT NULL, org_id uuid NOT NULL,
  user_id uuid NOT NULL, body text NOT NULL, status varchar(24) NOT NULL DEFAULT 'PENDING',
  interpreted jsonb NOT NULL DEFAULT '{}'::jsonb, applied_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hivemind.hq_todos (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), runtime_id uuid NOT NULL, org_id uuid NOT NULL,
  instruction_id uuid, title varchar(240) NOT NULL, objective text NOT NULL,
  kind varchar(60) NOT NULL, status varchar(32) NOT NULL DEFAULT 'READY', priority integer NOT NULL DEFAULT 100,
  position integer NOT NULL DEFAULT 0, required_capabilities jsonb NOT NULL DEFAULT '[]'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb, result jsonb NOT NULL DEFAULT '{}'::jsonb,
  blocked_reason text, started_at timestamptz, completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hivemind.hq_capability_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), runtime_id uuid NOT NULL, org_id uuid NOT NULL,
  todo_id uuid, capability varchar(100) NOT NULL, provider varchar(100) NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'REQUIRED', reason text NOT NULL,
  connect_path text, resolved_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hq_instructions_runtime_status_idx ON hivemind.hq_instructions(runtime_id,status,created_at);
CREATE INDEX IF NOT EXISTS hq_todos_runtime_status_position_idx ON hivemind.hq_todos(runtime_id,status,priority,position);
CREATE UNIQUE INDEX IF NOT EXISTS hq_capability_request_open_uq ON hivemind.hq_capability_requests(runtime_id,todo_id,capability) WHERE status='REQUIRED';
CREATE INDEX IF NOT EXISTS hq_capability_requests_org_status_idx ON hivemind.hq_capability_requests(org_id,status,created_at);

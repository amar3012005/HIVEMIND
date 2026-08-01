-- Durable, tenant-scoped HQ workflow graph. Apply with the repository manual
-- SQL procedure; do not use prisma migrate deploy.
CREATE TABLE IF NOT EXISTS hivemind.hq_workflows (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  runtime_id uuid NOT NULL,
  org_id uuid NOT NULL,
  todo_id uuid,
  kind varchar(80) NOT NULL,
  title varchar(240) NOT NULL,
  objective text NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'READY',
  graph_version integer NOT NULL DEFAULT 1,
  authority_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  context jsonb NOT NULL DEFAULT '{}'::jsonb,
  terminal_reason text,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hivemind.hq_workflow_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES hivemind.hq_workflows(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  step_key varchar(100) NOT NULL,
  title varchar(240) NOT NULL,
  kind varchar(80) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'PENDING',
  position integer NOT NULL,
  depends_on text[] NOT NULL DEFAULT ARRAY[]::text[],
  room_tag varchar(80),
  work_order_id uuid,
  acceptance jsonb NOT NULL DEFAULT '[]'::jsonb,
  input jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  retry_count integer NOT NULL DEFAULT 0,
  max_retries integer NOT NULL DEFAULT 2,
  blocked_reason text,
  due_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_workflow_steps_workflow_step_key_uq UNIQUE (workflow_id, step_key),
  CONSTRAINT hq_workflow_steps_work_order_uq UNIQUE (work_order_id)
);

CREATE TABLE IF NOT EXISTS hivemind.hq_workflow_artifacts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workflow_id uuid NOT NULL REFERENCES hivemind.hq_workflows(id) ON DELETE CASCADE,
  step_id uuid REFERENCES hivemind.hq_workflow_steps(id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  artifact_key varchar(180) NOT NULL,
  artifact_type varchar(80) NOT NULL,
  status varchar(32) NOT NULL DEFAULT 'READY',
  external_ref varchar(500),
  payload jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hq_workflow_artifacts_workflow_key_uq UNIQUE (workflow_id, artifact_key)
);

CREATE INDEX IF NOT EXISTS hq_workflows_runtime_status_created_idx
  ON hivemind.hq_workflows(runtime_id, status, created_at);
CREATE INDEX IF NOT EXISTS hq_workflows_org_kind_status_idx
  ON hivemind.hq_workflows(org_id, kind, status);
CREATE UNIQUE INDEX IF NOT EXISTS hq_workflows_runtime_todo_uq
  ON hivemind.hq_workflows(runtime_id, todo_id);
CREATE INDEX IF NOT EXISTS hq_workflow_steps_org_status_due_idx
  ON hivemind.hq_workflow_steps(org_id, status, due_at);
CREATE INDEX IF NOT EXISTS hq_workflow_steps_workflow_position_idx
  ON hivemind.hq_workflow_steps(workflow_id, position);
CREATE INDEX IF NOT EXISTS hq_workflow_artifacts_org_type_status_idx
  ON hivemind.hq_workflow_artifacts(org_id, artifact_type, status);
CREATE INDEX IF NOT EXISTS hq_workflow_artifacts_step_created_idx
  ON hivemind.hq_workflow_artifacts(step_id, created_at);

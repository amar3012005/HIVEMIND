CREATE TABLE "hivemind"."hyper_task_triggers" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  room_id uuid NOT NULL,
  employee_id uuid NOT NULL,
  kind varchar(16) NOT NULL,
  status varchar(16) NOT NULL DEFAULT 'active',
  task text NOT NULL,
  mode_preference varchar(16) NOT NULL DEFAULT 'auto',
  timezone varchar(64),
  local_time varchar(5),
  next_run_at timestamptz,
  event_key varchar(120),
  version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT hyper_task_trigger_kind CHECK (kind IN ('once', 'daily', 'event', 'manual')),
  CONSTRAINT hyper_task_trigger_status CHECK (status IN ('active', 'proposed', 'paused')),
  CONSTRAINT hyper_task_trigger_mode CHECK (mode_preference IN ('auto', 'direct', 'company'))
);
CREATE INDEX hyper_task_triggers_due_idx ON "hivemind"."hyper_task_triggers" (next_run_at)
  WHERE status = 'active' AND next_run_at IS NOT NULL;
CREATE INDEX hyper_task_triggers_owner_idx ON "hivemind"."hyper_task_triggers" (org_id, user_id, created_at DESC);

CREATE TABLE "hivemind"."hyper_task_occurrences" (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger_id uuid NOT NULL REFERENCES "hivemind"."hyper_task_triggers" (id) ON DELETE CASCADE,
  org_id uuid NOT NULL,
  logical_key varchar(160) NOT NULL,
  due_at timestamptz NOT NULL,
  status varchar(24) NOT NULL DEFAULT 'queued',
  lease_until timestamptz,
  workflow_id varchar(160),
  artifact_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trigger_id, logical_key),
  CONSTRAINT hyper_task_occurrence_status CHECK (status IN ('queued', 'dispatching', 'running', 'complete', 'failed', 'input_required'))
);
CREATE INDEX hyper_task_occurrences_claim_idx ON "hivemind"."hyper_task_occurrences" (status, lease_until);

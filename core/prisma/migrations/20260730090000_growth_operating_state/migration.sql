-- Growth Operating Loop foundation. Apply through the repository's manual SQL
-- production procedure; do not use prisma migrate deploy.
CREATE TABLE IF NOT EXISTS hivemind.growth_goals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, owner_user_id uuid NOT NULL,
  title varchar(255) NOT NULL, objective text NOT NULL, status varchar(24) NOT NULL DEFAULT 'ACTIVE',
  autonomy_mode varchar(24) NOT NULL DEFAULT 'MANUAL_REVIEW', policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hivemind.growth_stages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, growth_goal_id uuid NOT NULL,
  name varchar(255) NOT NULL, objective text NOT NULL, growth_constraint varchar(40) NOT NULL, status varchar(24) NOT NULL DEFAULT 'PLANNED',
  starts_at timestamptz, checkpoint_at timestamptz, ends_at timestamptz, channel_policy jsonb NOT NULL DEFAULT '{}'::jsonb,
  measurement jsonb NOT NULL DEFAULT '{}'::jsonb, source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hivemind.growth_hypotheses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, growth_stage_id uuid NOT NULL,
  statement text NOT NULL, confidence varchar(12) NOT NULL DEFAULT 'MEDIUM', evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  expected_signal text, falsification text, status varchar(20) NOT NULL DEFAULT 'OPEN', observed_outcome jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hivemind.growth_delegations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, growth_stage_id uuid NOT NULL, room_id uuid,
  room_tag varchar(40) NOT NULL, objective text NOT NULL, inputs jsonb NOT NULL DEFAULT '{}'::jsonb, deliverable varchar(500),
  success_metric varchar(500), status varchar(24) NOT NULL DEFAULT 'PENDING', result jsonb NOT NULL DEFAULT '{}'::jsonb,
  completed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS hivemind.growth_journal (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, growth_goal_id uuid, growth_stage_id uuid, actor_user_id uuid,
  event_type varchar(60) NOT NULL, summary text NOT NULL, evidence_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  decision jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS growth_goals_org_status_idx ON hivemind.growth_goals (org_id, status);
CREATE INDEX IF NOT EXISTS growth_stages_org_status_checkpoint_idx ON hivemind.growth_stages (org_id, status, checkpoint_at);
CREATE INDEX IF NOT EXISTS growth_hypotheses_stage_created_idx ON hivemind.growth_hypotheses (growth_stage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS growth_delegations_stage_created_idx ON hivemind.growth_delegations (growth_stage_id, created_at DESC);
CREATE INDEX IF NOT EXISTS growth_journal_org_created_idx ON hivemind.growth_journal (org_id, created_at DESC);

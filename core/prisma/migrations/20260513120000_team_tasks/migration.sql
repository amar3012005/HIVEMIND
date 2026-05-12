-- TeamTasks + TeamTaskMessages: persistent record of every multi-employee
-- collaboration run by the Python sidecar's TeamRoom (AgentScope-backed).
-- One row in team_tasks per "team task" the user kicks off; one row in
-- team_task_messages per phase output (investigate findings, claims,
-- reviews, revisions, syntheses, plus 'system' annotations from TeamRoom).

CREATE TABLE IF NOT EXISTS hivemind.team_tasks (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id          UUID        NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
  team_id         UUID        REFERENCES hivemind.teams(id) ON DELETE SET NULL,
  brief           TEXT        NOT NULL,
  requested_by    UUID        REFERENCES hivemind.users(id) ON DELETE SET NULL,
  -- Slack provenance: where the task came from + where to post outcome
  slack_channel   VARCHAR(64),
  slack_thread_ts VARCHAR(32),
  -- Roster snapshot at task start (array of employee_id for replay)
  roster_employee_ids UUID[]  NOT NULL DEFAULT ARRAY[]::UUID[],
  -- Lifecycle
  status          VARCHAR(20) NOT NULL DEFAULT 'running',
    -- running | completed | failed | cancelled
  rounds_completed INT        NOT NULL DEFAULT 0,
  max_rounds      INT         NOT NULL DEFAULT 2,
  gate_reason     VARCHAR(40),
    -- max_rounds | gate_satisfied | error | cancelled
  final_answer    TEXT,
  claim_count     INT         NOT NULL DEFAULT 0,
  review_count    INT         NOT NULL DEFAULT 0,
  revision_count  INT         NOT NULL DEFAULT 0,
  contradictions  INT         NOT NULL DEFAULT 0,
  -- Timing
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  started_at      TIMESTAMPTZ,
  completed_at    TIMESTAMPTZ,
  -- Error envelope when status='failed'
  error           TEXT
);

CREATE INDEX IF NOT EXISTS team_tasks_org_idx        ON hivemind.team_tasks (org_id);
CREATE INDEX IF NOT EXISTS team_tasks_team_idx       ON hivemind.team_tasks (team_id);
CREATE INDEX IF NOT EXISTS team_tasks_status_idx     ON hivemind.team_tasks (status);
CREATE INDEX IF NOT EXISTS team_tasks_created_at_idx ON hivemind.team_tasks (created_at DESC);
CREATE INDEX IF NOT EXISTS team_tasks_slack_idx
  ON hivemind.team_tasks (slack_channel, slack_thread_ts)
  WHERE slack_thread_ts IS NOT NULL;

CREATE TABLE IF NOT EXISTS hivemind.team_task_messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id         UUID        NOT NULL REFERENCES hivemind.team_tasks(id) ON DELETE CASCADE,
  -- sender_id is either a digital_employees.id OR the literal string 'system'.
  -- We store it as TEXT (not UUID FK) so phase-boundary system rows fit.
  sender_id       TEXT        NOT NULL,
  sender_name     VARCHAR(120) NOT NULL,
  sender_role     VARCHAR(60),
  -- kind: chat | claim | review | revision | synthesis | system
  kind            VARCHAR(20) NOT NULL,
  round_num       INT         NOT NULL DEFAULT 0,
  content         TEXT        NOT NULL,
  -- Metadata: phase, target_claim_id, verdict, revises_claim_id, etc.
  metadata        JSONB       NOT NULL DEFAULT '{}'::JSONB,
  ts              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS team_task_messages_task_idx
  ON hivemind.team_task_messages (task_id, ts);
CREATE INDEX IF NOT EXISTS team_task_messages_kind_idx
  ON hivemind.team_task_messages (task_id, kind);
CREATE INDEX IF NOT EXISTS team_task_messages_sender_idx
  ON hivemind.team_task_messages (sender_id)
  WHERE sender_id != 'system';

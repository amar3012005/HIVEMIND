-- pending_writes: agent draft-approval gate for non-readOnly tool calls.
-- Created when react-agent attempts to invoke a write tool
-- (slack_send_message, slack_schedule_message, …). FE renders the
-- draft, user clicks Approve → middleware re-executes the tool with
-- the stored args. Resolved rows kept for audit.

CREATE TABLE IF NOT EXISTS pending_writes (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL,
  org_id       UUID,
  provider     VARCHAR(50) NOT NULL,
  tool_name    VARCHAR(120) NOT NULL,
  tool_args    JSONB NOT NULL,
  preview      TEXT,
  status       VARCHAR(20) NOT NULL DEFAULT 'draft',
  result       JSONB,
  error_msg    TEXT,
  created_at   TIMESTAMPTZ(6) NOT NULL DEFAULT NOW(),
  approved_at  TIMESTAMPTZ(6),
  sent_at      TIMESTAMPTZ(6)
);

CREATE INDEX IF NOT EXISTS pending_writes_user_status_created_idx
  ON pending_writes (user_id, status, created_at DESC);

CREATE INDEX IF NOT EXISTS pending_writes_org_created_idx
  ON pending_writes (org_id, created_at DESC);

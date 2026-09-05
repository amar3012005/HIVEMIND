CREATE TABLE IF NOT EXISTS hivemind.activation_lifecycles (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invite_id UUID,
  org_id UUID,
  user_id UUID,
  email_hash CHAR(64) NOT NULL,
  email_hint VARCHAR(160) NOT NULL,
  stage VARCHAR(64) NOT NULL,
  generation INTEGER NOT NULL DEFAULT 1,
  reminder_count INTEGER NOT NULL DEFAULT 0,
  next_reminder_at TIMESTAMPTZ(6),
  last_reminder_at TIMESTAMPTZ(6),
  delivery_lease_until TIMESTAMPTZ(6),
  workflow_instance_id VARCHAR(128),
  stopped_at TIMESTAMPTZ(6),
  stop_reason VARCHAR(80),
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS activation_lifecycles_invite_id_uq
  ON hivemind.activation_lifecycles(invite_id) WHERE invite_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS activation_lifecycles_active_due_idx
  ON hivemind.activation_lifecycles(stage, next_reminder_at)
  WHERE stopped_at IS NULL;
CREATE INDEX IF NOT EXISTS activation_lifecycles_email_active_idx
  ON hivemind.activation_lifecycles(email_hash, created_at DESC)
  WHERE stopped_at IS NULL;

-- Account-created notifications are provider-facing writes.  Keep a separate
-- durable ledger so OAuth/email callback replays cannot email admins twice.
CREATE TABLE IF NOT EXISTS hivemind.account_admin_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES hivemind.users(id) ON DELETE CASCADE,
  recipient_hash CHAR(64) NOT NULL,
  recipient_hint VARCHAR(160) NOT NULL,
  notification_type VARCHAR(64) NOT NULL DEFAULT 'account_created',
  status VARCHAR(32) NOT NULL DEFAULT 'reserved',
  provider VARCHAR(64),
  delivery_status VARCHAR(64),
  provider_receipts JSONB NOT NULL DEFAULT '[]',
  provider_attempts INTEGER NOT NULL DEFAULT 0,
  send_lease_until TIMESTAMPTZ(6),
  submission_started_at TIMESTAMPTZ(6),
  accepted_at TIMESTAMPTZ(6),
  rejected_at TIMESTAMPTZ(6),
  last_error VARCHAR(240),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT account_admin_notifications_status_check CHECK (status IN ('reserved', 'submitted_unknown', 'accepted', 'rejected'))
);

CREATE UNIQUE INDEX IF NOT EXISTS account_admin_notifications_once_uq
  ON hivemind.account_admin_notifications (user_id, recipient_hash, notification_type);

CREATE INDEX IF NOT EXISTS account_admin_notifications_reconcile_idx
  ON hivemind.account_admin_notifications (status, submission_started_at)
  WHERE status = 'submitted_unknown';

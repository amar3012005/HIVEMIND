-- A Day-1 report is an irreversible, provider-facing lifecycle delivery.  The
-- room's JSON state is useful context, but it cannot be the delivery authority:
-- workflows may replay and a provider can accept a request before a caller
-- observes its response.  This ledger is the durable, recipient-scoped
-- authority for exactly-once submission.
CREATE TABLE IF NOT EXISTS hivemind.lifecycle_email_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  recipient_hash CHAR(64) NOT NULL,
  recipient_hint VARCHAR(160) NOT NULL,
  lifecycle_day SMALLINT NOT NULL,
  workflow_generation VARCHAR(128) NOT NULL,
  hq_room_id UUID,
  turn_id UUID,
  output_sha256 CHAR(64),
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
  CONSTRAINT lifecycle_email_deliveries_day_check CHECK (lifecycle_day > 0),
  CONSTRAINT lifecycle_email_deliveries_status_check CHECK (status IN ('reserved', 'submitted_unknown', 'accepted', 'rejected'))
);

-- The generation is lifecycle-owned, not a transient Worker execution ID.
-- Therefore duplicate HQ rooms and workflow replays resolve to the same row.
CREATE UNIQUE INDEX IF NOT EXISTS lifecycle_email_deliveries_once_uq
  ON hivemind.lifecycle_email_deliveries (org_id, recipient_hash, lifecycle_day, workflow_generation);

CREATE INDEX IF NOT EXISTS lifecycle_email_deliveries_reconcile_idx
  ON hivemind.lifecycle_email_deliveries (status, submission_started_at)
  WHERE status = 'submitted_unknown';

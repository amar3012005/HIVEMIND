ALTER TABLE hivemind.meeting_sessions
  ADD COLUMN IF NOT EXISTS finalization_payload jsonb,
  ADD COLUMN IF NOT EXISTS finalization_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS finalization_next_attempt_at timestamptz,
  ADD COLUMN IF NOT EXISTS finalization_lease_expires_at timestamptz;

CREATE INDEX IF NOT EXISTS meeting_sessions_finalization_retry_idx
  ON hivemind.meeting_sessions(status, finalization_next_attempt_at, updated_at);

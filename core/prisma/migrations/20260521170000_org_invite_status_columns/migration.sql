-- Add status-tracking columns to org_invites for the share-modal feature.
-- revoked_at / revoked_by: soft-revoke instead of hard delete so we keep
-- an audit trail and can show "revoked" in the invite-status list.
-- last_sent_at / send_count: track resends from the share popup.
ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "revoked_at" timestamptz(6),
  ADD COLUMN IF NOT EXISTS "revoked_by" uuid,
  ADD COLUMN IF NOT EXISTS "last_sent_at" timestamptz(6),
  ADD COLUMN IF NOT EXISTS "send_count" integer NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS "org_invites_revoked_at_idx" ON "org_invites" ("revoked_at");

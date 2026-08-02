-- Workspace Admin production gate. Apply through the manual SQL release
-- procedure; this migration is additive and idempotent.
ALTER TABLE hivemind.org_invites
  ADD COLUMN IF NOT EXISTS idempotency_key varchar(200);

ALTER TABLE hivemind.user_organizations
  ADD COLUMN IF NOT EXISTS cognition_personal_opt_in boolean NOT NULL DEFAULT false;

CREATE UNIQUE INDEX IF NOT EXISTS org_invites_org_creator_idempotency_key_uidx
  ON hivemind.org_invites (org_id, created_by, idempotency_key);

CREATE TABLE IF NOT EXISTS hivemind.workspace_notifications (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  user_id uuid NOT NULL,
  type varchar(80) NOT NULL,
  title varchar(180) NOT NULL,
  body text,
  resource_type varchar(80),
  resource_id varchar(128),
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key varchar(200),
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS workspace_notifications_org_user_created_idx
  ON hivemind.workspace_notifications (org_id, user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS workspace_notifications_org_user_unread_idx
  ON hivemind.workspace_notifications (org_id, user_id, read_at);
CREATE UNIQUE INDEX IF NOT EXISTS workspace_notifications_org_user_dedupe_uidx
  ON hivemind.workspace_notifications (org_id, user_id, dedupe_key);

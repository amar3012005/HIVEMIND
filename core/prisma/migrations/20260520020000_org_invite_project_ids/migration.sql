-- Phase 1: OrgInvite gains projectIds for invite → project-membership flow.
ALTER TABLE hivemind.org_invites
  ADD COLUMN IF NOT EXISTS project_ids UUID[] NOT NULL DEFAULT ARRAY[]::UUID[];

CREATE INDEX IF NOT EXISTS idx_org_invites_project_ids
  ON hivemind.org_invites USING GIN (project_ids);

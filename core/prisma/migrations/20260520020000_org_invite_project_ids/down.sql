DROP INDEX IF EXISTS hivemind.idx_org_invites_project_ids;
ALTER TABLE hivemind.org_invites DROP COLUMN IF EXISTS project_ids;

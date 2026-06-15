-- M7: project-level provenance for profile facts. NULL = org-level identity
-- (evidence spans multiple projects or none). A project id scopes the fact so a
-- project-scoped caller never sees identity facts derived from OTHER projects.
-- Additive + nullable → backward-compatible (existing rows = NULL = org-level).
ALTER TABLE hivemind.user_profiles ADD COLUMN IF NOT EXISTS project_id UUID;
CREATE INDEX IF NOT EXISTS user_profiles_user_org_project_idx
  ON hivemind.user_profiles (user_id, org_id, project_id);

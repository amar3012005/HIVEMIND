ALTER TABLE hivemind.api_keys
  DROP COLUMN IF EXISTS project_id,
  DROP COLUMN IF EXISTS team_id;

ALTER TABLE hivemind.organizations
  DROP COLUMN IF EXISTS default_project_policy;

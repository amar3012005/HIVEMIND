-- Add missing columns that Prisma schema expects but production drifted
-- away from. Idempotent so re-running on a schema-aligned DB is a no-op.

ALTER TABLE hivemind.organizations
  ADD COLUMN IF NOT EXISTS default_project_policy VARCHAR(50) NOT NULL DEFAULT 'private';

ALTER TABLE hivemind.api_keys
  ADD COLUMN IF NOT EXISTS project_id UUID,
  ADD COLUMN IF NOT EXISTS team_id UUID,
  ADD COLUMN IF NOT EXISTS rate_limit_per_minute INTEGER DEFAULT 60;

CREATE INDEX IF NOT EXISTS idx_api_keys_project ON hivemind.api_keys(project_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_team ON hivemind.api_keys(team_id);

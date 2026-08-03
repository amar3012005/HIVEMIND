-- Versioned platform plan-cap overlays. The latest row per plan is effective;
-- every apply and default restore preserves the preceding version.
CREATE TABLE IF NOT EXISTS hivemind.plan_catalog_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id VARCHAR(50) NOT NULL,
  version INTEGER NOT NULL,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  action VARCHAR(32) NOT NULL,
  operator VARCHAR(160) NOT NULL,
  request_id VARCHAR(128),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT plan_catalog_versions_plan_version_unique UNIQUE (plan_id, version),
  CONSTRAINT plan_catalog_versions_action_check CHECK (action IN ('apply', 'restore_default'))
);

CREATE INDEX IF NOT EXISTS plan_catalog_versions_plan_created_idx
  ON hivemind.plan_catalog_versions (plan_id, created_at DESC);

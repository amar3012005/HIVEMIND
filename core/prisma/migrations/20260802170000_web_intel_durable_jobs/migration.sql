CREATE TABLE IF NOT EXISTS hivemind.web_intel_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, user_id uuid NOT NULL,
  type varchar(24) NOT NULL, status varchar(24) NOT NULL DEFAULT 'queued', request jsonb NOT NULL DEFAULT '{}'::jsonb,
  result jsonb, progress jsonb NOT NULL DEFAULT '[]'::jsonb, provider_attempts jsonb NOT NULL DEFAULT '[]'::jsonb,
  idempotency_key varchar(128), runtime_used varchar(64), fallback_applied boolean NOT NULL DEFAULT false,
  duration_ms integer, pages_processed integer NOT NULL DEFAULT 0, error_code varchar(80), error_message text,
  retried_from_id uuid, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS web_intel_jobs_idempotency_uq ON hivemind.web_intel_jobs (org_id, user_id, idempotency_key) WHERE idempotency_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS web_intel_jobs_owner_updated_idx ON hivemind.web_intel_jobs (org_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS web_intel_jobs_status_updated_idx ON hivemind.web_intel_jobs (org_id, status, updated_at);
CREATE TABLE IF NOT EXISTS hivemind.web_intel_usage_settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), org_id uuid NOT NULL, user_id uuid NOT NULL, job_id uuid NOT NULL,
  metric varchar(40) NOT NULL, amount bigint NOT NULL DEFAULT 1, metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (job_id, metric)
);
CREATE INDEX IF NOT EXISTS web_intel_usage_settlements_org_user_idx ON hivemind.web_intel_usage_settlements (org_id, user_id, created_at DESC);

-- API key ownership upgrade. Existing keys remain personal and retain their
-- declared scopes; service keys are explicit and organization-admin governed.
ALTER TABLE hivemind.api_keys ADD COLUMN IF NOT EXISTS key_kind varchar(16) NOT NULL DEFAULT 'personal';
ALTER TABLE hivemind.api_keys ADD COLUMN IF NOT EXISTS created_by_user_id uuid;
UPDATE hivemind.api_keys SET created_by_user_id = user_id WHERE created_by_user_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_org_kind ON hivemind.api_keys (org_id, key_kind);

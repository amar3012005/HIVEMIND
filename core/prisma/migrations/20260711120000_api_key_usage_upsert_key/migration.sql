-- Runtime recordKeyUsage upserts aggregate one row per org/key/month/model.
-- Older production baselines only have a five-column unique index including feature,
-- which PostgreSQL cannot infer for the four-column ON CONFLICT target.
CREATE UNIQUE INDEX IF NOT EXISTS "uq_api_key_usage_org_key_month_model"
  ON "api_key_usage" ("org_id", "api_key_id", "month", "model");

CREATE SCHEMA IF NOT EXISTS hivemind;

CREATE TABLE IF NOT EXISTS hivemind.ai_model_policies (
  use_case varchar(80) PRIMARY KEY,
  primary_model varchar(160) NOT NULL,
  secondary_model varchar(160),
  enabled boolean NOT NULL DEFAULT true,
  revision integer NOT NULL DEFAULT 1,
  updated_by varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK (primary_model ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+$'),
  CHECK (secondary_model IS NULL OR secondary_model ~ '^[A-Za-z0-9._-]+/[A-Za-z0-9._:-]+$'),
  CHECK (secondary_model IS NULL OR secondary_model <> primary_model)
);

CREATE TABLE IF NOT EXISTS hivemind.ai_model_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  model varchar(160) NOT NULL,
  provider varchar(80) NOT NULL DEFAULT '*',
  currency char(3) NOT NULL DEFAULT 'USD',
  input_micros_per_million bigint NOT NULL DEFAULT 0,
  output_micros_per_million bigint NOT NULL DEFAULT 0,
  cache_read_micros_per_million bigint NOT NULL DEFAULT 0,
  effective_from timestamptz NOT NULL DEFAULT now(),
  effective_to timestamptz,
  updated_by varchar(120),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (input_micros_per_million >= 0),
  CHECK (output_micros_per_million >= 0),
  CHECK (cache_read_micros_per_million >= 0),
  CHECK (effective_to IS NULL OR effective_to > effective_from)
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_ai_model_prices_active
  ON hivemind.ai_model_prices(model, provider) WHERE effective_to IS NULL;

CREATE TABLE IF NOT EXISTS hivemind.ai_usage_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  idempotency_key varchar(180) NOT NULL UNIQUE,
  org_id uuid,
  user_id uuid,
  api_key_id uuid,
  trace_id varchar(160),
  use_case varchar(80) NOT NULL DEFAULT 'unspecified',
  requested_model varchar(160) NOT NULL,
  served_model varchar(160) NOT NULL,
  provider varchar(80) NOT NULL DEFAULT 'unknown',
  prompt_tokens bigint NOT NULL DEFAULT 0,
  completion_tokens bigint NOT NULL DEFAULT 0,
  cached_prompt_tokens bigint NOT NULL DEFAULT 0,
  reasoning_tokens bigint NOT NULL DEFAULT 0,
  input_cost_micros bigint NOT NULL DEFAULT 0,
  output_cost_micros bigint NOT NULL DEFAULT 0,
  cache_cost_micros bigint NOT NULL DEFAULT 0,
  provider_reported_cost_micros bigint,
  total_cost_micros bigint NOT NULL DEFAULT 0,
  pricing_source varchar(40) NOT NULL DEFAULT 'catalog',
  applied_pricing jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(24) NOT NULL DEFAULT 'completed',
  gateway_request_id varchar(160),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  CHECK (prompt_tokens >= 0 AND completion_tokens >= 0 AND cached_prompt_tokens >= 0 AND reasoning_tokens >= 0),
  CHECK (total_cost_micros >= 0),
  CHECK (provider_reported_cost_micros IS NULL OR provider_reported_cost_micros >= 0)
);
CREATE INDEX IF NOT EXISTS idx_ai_usage_user_time ON hivemind.ai_usage_events(user_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_org_time ON hivemind.ai_usage_events(org_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS idx_ai_usage_model_time ON hivemind.ai_usage_events(served_model, provider, occurred_at DESC);

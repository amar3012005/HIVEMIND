CREATE TABLE IF NOT EXISTS hivemind.org_usage_cumulative (
  org_id UUID PRIMARY KEY,
  tokens_processed BIGINT NOT NULL DEFAULT 0,
  search_queries BIGINT NOT NULL DEFAULT 0,
  knowledge_base_uploads BIGINT NOT NULL DEFAULT 0,
  knowledge_base_pages BIGINT NOT NULL DEFAULT 0,
  memories_ingested BIGINT NOT NULL DEFAULT 0,
  deep_research_jobs BIGINT NOT NULL DEFAULT 0,
  web_intel_jobs BIGINT NOT NULL DEFAULT 0,
  graph_queries BIGINT NOT NULL DEFAULT 0,
  tara_usage BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Preserve existing historical usage on rollout. This is a one-time seed from
-- prior monthly counters; subsequent writes are strictly additive.
INSERT INTO hivemind.org_usage_cumulative (
  org_id, tokens_processed, search_queries, knowledge_base_uploads,
  knowledge_base_pages, memories_ingested, deep_research_jobs, web_intel_jobs,
  graph_queries, tara_usage, updated_at
)
SELECT "orgId", SUM("tokensProcessed"), SUM("searchQueries"), SUM("knowledgeBaseUploads"),
       SUM("knowledgeBasePages"), SUM("memoriesIngested"), SUM("deepResearchJobs"), SUM("webIntelJobs"),
       SUM("graphQueries"), SUM("taraUsage"), NOW()
FROM hivemind."OrgUsage"
GROUP BY "orgId"
ON CONFLICT (org_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS hivemind.referral_campaigns (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  max_redemptions INTEGER,
  redemption_count INTEGER NOT NULL DEFAULT 0,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  onboarding_days INTEGER NOT NULL DEFAULT 14,
  onboarding_plan VARCHAR(50) NOT NULL DEFAULT 'enterprise',
  onboarding_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  runway_plan VARCHAR(50) NOT NULL DEFAULT 'enterprise',
  runway_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (onboarding_days BETWEEN 1 AND 90),
  CHECK (max_redemptions IS NULL OR max_redemptions > 0)
);

-- Initial GTM partner offer. This is deliberately bounded: after fourteen
-- days the runway entitlement resolves to free until a contract is selected.
INSERT INTO hivemind.referral_campaigns (
  code, name, active, onboarding_days, onboarding_plan, onboarding_limits, runway_plan, runway_limits
) VALUES (
  'GTM2026', 'GTM Partners 2026', TRUE, 14, 'enterprise',
  '{"maxUsers":10,"maxProjects":10,"llmTokensPerMonth":5000000,"llmTokensPerDay":750000,"maxMemories":100000,"maxConnectors":20,"knowledgeBaseUploadsPerMonth":100,"knowledgeBasePagesPerMonth":10000,"maxHyperRooms":5}'::jsonb,
  'free', '{}'::jsonb
) ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS hivemind.referral_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id UUID NOT NULL REFERENCES hivemind.referral_campaigns(id) ON DELETE RESTRICT,
  org_id UUID NOT NULL UNIQUE,
  redeemed_by_user_id UUID NOT NULL,
  code_snapshot VARCHAR(64) NOT NULL,
  terms_snapshot JSONB NOT NULL,
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS referral_redemptions_campaign_idx ON hivemind.referral_redemptions(campaign_id);

CREATE TABLE IF NOT EXISTS hivemind.organization_entitlements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  source VARCHAR(32) NOT NULL,
  phase VARCHAR(32) NOT NULL,
  plan_id VARCHAR(50) NOT NULL,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL,
  effective_until TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE INDEX IF NOT EXISTS organization_entitlements_active_idx
  ON hivemind.organization_entitlements(org_id, effective_from DESC);

-- Existing rollups omitted feature from their uniqueness key, which merged
-- different product surfaces under the first feature seen for a model.
DROP INDEX IF EXISTS hivemind.uq_api_key_usage_org_key_month_model;
CREATE UNIQUE INDEX IF NOT EXISTS uq_api_key_usage_org_key_month_model_feature
  ON hivemind.api_key_usage(org_id, api_key_id, month, model, feature);

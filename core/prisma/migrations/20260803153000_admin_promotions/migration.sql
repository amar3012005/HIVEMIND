-- Admin Promotions: immutable, tenant-scoped commercial grants.
-- Apply with the repository's manual SQL production procedure; do not use prisma migrate deploy.

ALTER TABLE hivemind.organizations
  ADD COLUMN IF NOT EXISTS account_type VARCHAR(32);

UPDATE hivemind.organizations AS organization
SET account_type = CASE
  WHEN to_jsonb(organization)->>'hosting_mode' = 'self_host' THEN 'enterprise_self_hosted'
  WHEN COALESCE(to_jsonb(organization)->>'plan', 'free') IN ('enterprise', 'managed') THEN 'enterprise_managed'
  ELSE 'personal'
END
WHERE account_type IS NULL;

ALTER TABLE hivemind.organizations
  ALTER COLUMN account_type SET DEFAULT 'personal';

CREATE TABLE IF NOT EXISTS hivemind.promotions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legacy_campaign_id UUID UNIQUE REFERENCES hivemind.referral_campaigns(id) ON DELETE RESTRICT,
  internal_name VARCHAR(160) NOT NULL,
  code_hash CHAR(64) UNIQUE,
  code_hint VARCHAR(16),
  visibility VARCHAR(24) NOT NULL DEFAULT 'code',
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  billing_mode VARCHAR(32) NOT NULL DEFAULT 'entitlement_only',
  max_redemptions INTEGER,
  redemption_count INTEGER NOT NULL DEFAULT 0,
  per_email_max INTEGER NOT NULL DEFAULT 1,
  starts_at TIMESTAMPTZ,
  ends_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (visibility IN ('code', 'invite_only')),
  CHECK (status IN ('draft', 'active', 'revoked', 'expired')),
  CHECK (billing_mode IN ('entitlement_only', 'stripe_discount', 'contract')),
  CHECK (max_redemptions IS NULL OR max_redemptions > 0),
  CHECK (per_email_max > 0),
  CHECK (ends_at IS NULL OR starts_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE IF NOT EXISTS hivemind.promotion_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES hivemind.promotions(id) ON DELETE RESTRICT,
  version INTEGER NOT NULL,
  base_plan VARCHAR(50) NOT NULL,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  account_type VARCHAR(32) NOT NULL,
  hosting_mode VARCHAR(24) NOT NULL,
  storage_mode VARCHAR(32) NOT NULL,
  commercial_terms JSONB NOT NULL DEFAULT '{}'::jsonb,
  fallback_action VARCHAR(32) NOT NULL DEFAULT 'manual_review',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (promotion_id, version),
  CHECK (account_type IN ('personal', 'enterprise_managed', 'enterprise_self_hosted')),
  CHECK (hosting_mode IN ('managed', 'self_host')),
  CHECK (fallback_action IN ('free', 'pro', 'scale', 'manual_review'))
);

CREATE TABLE IF NOT EXISTS hivemind.promotion_eligibilities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES hivemind.promotions(id) ON DELETE CASCADE,
  eligibility_type VARCHAR(24) NOT NULL,
  value_hash CHAR(64),
  value_hint VARCHAR(160),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (promotion_id, eligibility_type, value_hash),
  CHECK (eligibility_type IN ('anyone', 'email', 'domain', 'organization', 'invite_only'))
);

CREATE TABLE IF NOT EXISTS hivemind.entitlement_grants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES hivemind.organizations(id) ON DELETE RESTRICT,
  promotion_id UUID REFERENCES hivemind.promotions(id) ON DELETE RESTRICT,
  source VARCHAR(48) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'active',
  starts_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ends_at TIMESTAMPTZ,
  fallback_action VARCHAR(32) NOT NULL DEFAULT 'manual_review',
  suspended_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (status IN ('active', 'suspended', 'revoked')),
  CHECK (fallback_action IN ('free', 'pro', 'scale', 'manual_review')),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX IF NOT EXISTS entitlement_grants_org_active_idx
  ON hivemind.entitlement_grants(org_id, status, starts_at DESC);

CREATE TABLE IF NOT EXISTS hivemind.entitlement_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  grant_id UUID NOT NULL REFERENCES hivemind.entitlement_grants(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  plan_id VARCHAR(50) NOT NULL,
  limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  account_type VARCHAR(32) NOT NULL,
  hosting_mode VARCHAR(24) NOT NULL,
  storage_mode VARCHAR(32) NOT NULL,
  commercial_terms JSONB NOT NULL DEFAULT '{}'::jsonb,
  effective_from TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,
  transition_reason VARCHAR(80) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (grant_id, version),
  CHECK (effective_until IS NULL OR effective_until > effective_from)
);
CREATE INDEX IF NOT EXISTS entitlement_versions_effective_idx
  ON hivemind.entitlement_versions(grant_id, effective_from DESC);

CREATE TABLE IF NOT EXISTS hivemind.promotion_redemptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  promotion_id UUID NOT NULL REFERENCES hivemind.promotions(id) ON DELETE RESTRICT,
  promotion_version_id UUID NOT NULL REFERENCES hivemind.promotion_versions(id) ON DELETE RESTRICT,
  entitlement_grant_id UUID NOT NULL REFERENCES hivemind.entitlement_grants(id) ON DELETE RESTRICT,
  org_id UUID NOT NULL REFERENCES hivemind.organizations(id) ON DELETE RESTRICT,
  redeemed_by_user_id UUID NOT NULL,
  email_hash CHAR(64) NOT NULL,
  code_hint VARCHAR(16),
  terms_snapshot JSONB NOT NULL,
  request_id VARCHAR(128),
  redeemed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (promotion_id, org_id)
);
CREATE INDEX IF NOT EXISTS promotion_redemptions_promotion_email_idx
  ON hivemind.promotion_redemptions(promotion_id, email_hash);
CREATE INDEX IF NOT EXISTS promotion_redemptions_org_idx
  ON hivemind.promotion_redemptions(org_id, redeemed_at DESC);

-- B2B Enterprise Invitations. Apply with the repository manual SQL production
-- procedure; do not run prisma migrate deploy.

CREATE TABLE IF NOT EXISTS hivemind.enterprise_invitations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name VARCHAR(255) NOT NULL,
  workspace_name VARCHAR(255),
  recipient_email VARCHAR(255) NOT NULL,
  recipient_email_hash CHAR(64) NOT NULL,
  recipient_email_hint VARCHAR(160) NOT NULL,
  account_type VARCHAR(32) NOT NULL,
  hosting_mode VARCHAR(24) NOT NULL,
  storage_mode VARCHAR(32) NOT NULL,
  onboarding_days INTEGER NOT NULL DEFAULT 14,
  onboarding_limits JSONB NOT NULL DEFAULT '{}'::jsonb,
  config_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  welcome_message TEXT,
  private_notes TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'draft',
  delivery_status VARCHAR(24) NOT NULL DEFAULT 'not_sent',
  last_delivery_error VARCHAR(240),
  access_code_hash CHAR(64) NOT NULL UNIQUE,
  access_code_hint VARCHAR(16) NOT NULL,
  access_code_version INTEGER NOT NULL DEFAULT 1,
  link_token_hash CHAR(64) NOT NULL UNIQUE,
  link_version INTEGER NOT NULL DEFAULT 1,
  invitation_expires_at TIMESTAMPTZ NOT NULL,
  sent_at TIMESTAMPTZ,
  last_sent_at TIMESTAMPTZ,
  redeemed_at TIMESTAMPTZ,
  redeemed_by_user_id UUID,
  org_id UUID UNIQUE REFERENCES hivemind.organizations(id) ON DELETE RESTRICT,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (account_type IN ('enterprise_managed', 'enterprise_self_hosted')),
  CHECK (hosting_mode IN ('managed', 'self_host')),
  CHECK (status IN ('draft', 'sent', 'redeeming', 'redeemed', 'expired', 'revoked')),
  CHECK (delivery_status IN ('not_sent', 'sent', 'failed')),
  CHECK (onboarding_days BETWEEN 1 AND 90),
  CHECK (invitation_expires_at > created_at)
);

CREATE INDEX IF NOT EXISTS enterprise_invitations_recipient_status_idx
  ON hivemind.enterprise_invitations(recipient_email_hash, status);
CREATE INDEX IF NOT EXISTS enterprise_invitations_status_expiry_idx
  ON hivemind.enterprise_invitations(status, invitation_expires_at);

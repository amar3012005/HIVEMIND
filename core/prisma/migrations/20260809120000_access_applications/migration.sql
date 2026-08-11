-- Public B2C/B2B access applications. Apply with the repository manual SQL
-- procedure; never with prisma migrate deploy.
CREATE TABLE IF NOT EXISTS hivemind.access_applications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email VARCHAR(255) NOT NULL,
  email_hash CHAR(64) NOT NULL,
  name VARCHAR(160) NOT NULL,
  account_type VARCHAR(24) NOT NULL,
  company_name VARCHAR(255),
  use_case VARCHAR(120),
  niche VARCHAR(120),
  message TEXT,
  source VARCHAR(160) NOT NULL DEFAULT 'singulancelabs.com',
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  review_note TEXT,
  reviewed_by VARCHAR(160),
  reviewed_at TIMESTAMPTZ,
  invitation_type VARCHAR(24),
  enterprise_invitation_id UUID,
  invitation_sent_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT access_applications_email_type_key UNIQUE (email_hash, account_type),
  CONSTRAINT access_applications_account_type_check CHECK (account_type IN ('personal', 'enterprise')),
  CONSTRAINT access_applications_status_check CHECK (status IN ('pending', 'approved', 'discarded', 'invited', 'converted'))
);
CREATE INDEX IF NOT EXISTS access_applications_type_status_created_idx
  ON hivemind.access_applications(account_type, status, created_at DESC);

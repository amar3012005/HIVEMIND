-- Provider-neutral sender receipt ledger for the platform-admin timeline.
-- Addresses remain in the existing identity/invitation tables; this table stores
-- only a hash and a small redacted hint for safe reconciliation.
CREATE TABLE IF NOT EXISTS hivemind.system_email_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recipient_hash CHAR(64) NOT NULL,
  recipient_hint VARCHAR(160) NOT NULL,
  org_id UUID,
  user_id UUID,
  activation_id UUID,
  template_id VARCHAR(120) NOT NULL,
  subject VARCHAR(300) NOT NULL,
  provider VARCHAR(64),
  provider_message_id VARCHAR(512),
  delivery_status VARCHAR(64) NOT NULL,
  provider_receipts JSONB NOT NULL DEFAULT '[]',
  accepted_at TIMESTAMPTZ(6),
  rejected_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS system_email_deliveries_provider_message_uq
  ON hivemind.system_email_deliveries (provider, provider_message_id)
  WHERE provider_message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS system_email_deliveries_recipient_idx
  ON hivemind.system_email_deliveries (recipient_hash, created_at DESC);
CREATE INDEX IF NOT EXISTS system_email_deliveries_org_idx
  ON hivemind.system_email_deliveries (org_id, created_at DESC)
  WHERE org_id IS NOT NULL;

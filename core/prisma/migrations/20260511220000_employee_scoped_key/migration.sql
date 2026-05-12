-- Add encrypted-at-rest storage for the per-employee scoped HIVEMIND API key.
-- Slack-app-tokens (xapp-) remain admin-managed via env vars; bot tokens
-- (xoxb-) come from platform_integrations on demand. The bootstrap endpoint
-- decrypts both at fetch time for the Python sidecar.

ALTER TABLE "digital_employees"
  ADD COLUMN IF NOT EXISTS "scoped_api_key_encrypted" TEXT;

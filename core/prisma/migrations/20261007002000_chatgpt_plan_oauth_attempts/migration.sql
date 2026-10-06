CREATE TABLE hivemind.chatgpt_plan_oauth_attempts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES hivemind.users(id) ON DELETE CASCADE,
  state_hash VARCHAR(64) UNIQUE NOT NULL,
  encrypted_context TEXT NOT NULL,
  expires_at TIMESTAMPTZ(6) NOT NULL,
  consumed_at TIMESTAMPTZ(6),
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX chatgpt_plan_oauth_attempts_owner_expiry_idx
ON hivemind.chatgpt_plan_oauth_attempts(org_id, user_id, expires_at);

-- Phase 6h follow-up — per-tenant scoped MCP tokens.
-- Each tenant profile gets its OWN HiveMind API key (scoped to that org) instead
-- of the shared master key, so a compromised profile cannot read other orgs'
-- memory. The raw key is written only into the profile's .env on the root-only
-- volume; here we keep the key id + prefix for audit/revoke. Additive, idempotent.
ALTER TABLE hivemind.hermes_runtimes ADD COLUMN IF NOT EXISTS mcp_key_id     text;
ALTER TABLE hivemind.hermes_runtimes ADD COLUMN IF NOT EXISTS mcp_key_prefix text;

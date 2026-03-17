-- ==========================================
-- Migration: Create API Keys Table
-- HIVE-MIND Cross-Platform Context Sync
-- GDPR, NIS2, DORA Compliant
-- ==========================================

-- Create API keys table for server-to-server authentication
-- Supports key expiry, revocation, and last-used tracking
CREATE TABLE IF NOT EXISTS api_keys (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,

    -- Key identification
    name VARCHAR(255) NOT NULL,  -- Human-readable name for the key
    key_hash VARCHAR(255) UNIQUE NOT NULL,  -- SHA-256 hash of the actual API key
    key_prefix VARCHAR(20) NOT NULL,  -- First 8 chars for identification (e.g., "hmk_abc123")

    -- Key lifecycle
    expires_at TIMESTAMPTZ,  -- NULL = never expires
    revoked_at TIMESTAMPTZ,  -- NULL = still active
    revoked_reason VARCHAR(255),  -- Reason for revocation (user-provided or system)

    -- Usage tracking
    last_used_at TIMESTAMPTZ,  -- Last successful authentication
    usage_count INTEGER DEFAULT 0,  -- Total number of successful authentications

    -- Permissions & scopes
    scopes TEXT[] DEFAULT ARRAY['read', 'write'],  -- Permission scopes
    rate_limit_per_minute INTEGER DEFAULT 60,  -- Rate limiting per key

    -- Metadata
    description TEXT,
    created_by_ip INET,  -- IP address where key was created
    user_agent TEXT,  -- User agent at creation time

    -- Timestamps
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    -- Constraints
    CONSTRAINT chk_key_prefix_length CHECK (char_length(key_prefix) >= 6),
    CONSTRAINT chk_rate_limit_positive CHECK (rate_limit_per_minute > 0)
);

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_api_keys_user ON api_keys(user_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_org ON api_keys(org_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_hash ON api_keys(key_hash);
CREATE INDEX IF NOT EXISTS idx_api_keys_key_prefix ON api_keys(key_prefix);
CREATE INDEX IF NOT EXISTS idx_api_keys_active ON api_keys(user_id, revoked_at, expires_at) 
    WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_api_keys_expires_at ON api_keys(expires_at);

-- Comments for documentation
COMMENT ON TABLE api_keys IS 'API keys for server-to-server authentication with expiry and revocation support';
COMMENT ON COLUMN api_keys.key_hash IS 'SHA-256 hash of the actual API key for secure storage';
COMMENT ON COLUMN api_keys.key_prefix IS 'First 8 characters of the API key for user identification';
COMMENT ON COLUMN api_keys.scopes IS 'Permission scopes: read, write, admin, memories:read, memories:write, etc.';
COMMENT ON COLUMN api_keys.rate_limit_per_minute IS 'Maximum requests per minute for this key';

-- Helper triggers may not exist on fresh local databases yet
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION audit_trigger_function()
RETURNS TRIGGER AS $$
BEGIN
    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Create trigger for updated_at
CREATE TRIGGER update_api_keys_updated_at
    BEFORE UPDATE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Enable Row Level Security
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;

-- RLS Policies for multi-tenant isolation
-- Users can only see and manage their own API keys
CREATE POLICY api_keys_user_isolation ON api_keys
    FOR ALL
    USING (
        -- Allow access if user_id matches the authenticated user
        user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), '')
        OR
        -- Allow organization admins to manage org keys
        (
            org_id IS NOT NULL
            AND EXISTS (
                SELECT 1 FROM user_organizations uo
                WHERE uo.org_id = api_keys.org_id
                AND uo.user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), '')
                AND uo.role IN ('owner', 'admin')
            )
        )
    );

-- Service role can bypass RLS (for background jobs)
CREATE POLICY api_keys_service_access ON api_keys
    FOR ALL
    USING (
        NULLIF(current_setting('app.service_role', TRUE), '')::BOOLEAN IS TRUE
    );

-- Audit trigger for API key changes (security-critical)
CREATE TRIGGER audit_api_keys_changes
    AFTER INSERT OR UPDATE OR DELETE ON api_keys
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

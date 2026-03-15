-- Migration: 001_initial_schema
-- Description: Initial HIVE-MIND schema with PostgreSQL 15 + Apache AGE
-- Compliance: GDPR, NIS2, DORA
-- Data Residency: EU (DE/FR/FI)
-- Created: 2026-03-09

-- ==========================================
-- UP MIGRATION
-- ==========================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "age";

-- Load Apache AGE
LOAD 'age';
SET search_path = ag_catalog, "$user", public;

-- Create encryption schema
CREATE SCHEMA IF NOT EXISTS encryption;

-- Create enums
DO $$ BEGIN
    CREATE TYPE memory_type AS ENUM ('fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE relationship_type AS ENUM ('Updates', 'Extends', 'Derives');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

DO $$ BEGIN
    CREATE TYPE visibility_scope AS ENUM ('private', 'organization', 'public');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Create Apache AGE graph
SELECT create_graph('hivemind_memory_graph');

-- Create encryption audit table
CREATE TABLE IF NOT EXISTS encryption.audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    operation VARCHAR(20) NOT NULL CHECK (operation IN ('encrypt', 'decrypt', 'key_rotation')),
    key_id UUID NOT NULL,
    key_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_encryption_audit_key ON encryption.audit_log(key_id);
CREATE INDEX IF NOT EXISTS idx_encryption_audit_time ON encryption.audit_log(created_at DESC);

-- Create views
CREATE OR REPLACE VIEW active_memories AS
SELECT
    m.*,
    u.email as user_email,
    o.name as org_name,
    o.data_residency_region
FROM memories m
JOIN users u ON m.user_id = u.id
LEFT JOIN organizations o ON m.org_id = o.id
WHERE m.is_latest = TRUE
  AND m.deleted_at IS NULL
  AND (m.retention_until IS NULL OR m.retention_until > CURRENT_TIMESTAMP);

CREATE OR REPLACE VIEW user_platform_sync_status AS
SELECT
    u.id as user_id,
    u.email,
    pi.platform_type,
    pi.is_active,
    pi.sync_status,
    pi.last_synced_at,
    pi.consecutive_failures,
    CASE
        WHEN pi.consecutive_failures >= 3 THEN 'critical'
        WHEN pi.consecutive_failures >= 1 THEN 'warning'
        WHEN pi.last_synced_at < CURRENT_TIMESTAMP - INTERVAL '1 hour' THEN 'stale'
        ELSE 'healthy'
    END as health_status
FROM users u
LEFT JOIN platform_integrations pi ON u.id = pi.user_id
WHERE u.deleted_at IS NULL;

-- Create trigger function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply triggers
CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_platform_integrations_updated_at BEFORE UPDATE ON platform_integrations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_memories_updated_at BEFORE UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_vector_embeddings_updated_at BEFORE UPDATE ON vector_embeddings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Create audit trigger function
CREATE OR REPLACE FUNCTION audit_trigger_function()
RETURNS TRIGGER AS $$
DECLARE
    old_val JSONB;
    new_val JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        new_val := to_jsonb(NEW);
        INSERT INTO audit_logs (
            event_type, event_category, resource_type, resource_id,
            action, new_value, created_at
        ) VALUES (
            TG_TABLE_NAME || '_created', 'data_modification', TG_TABLE_NAME, NEW.id,
            'create', new_val, CURRENT_TIMESTAMP
        );
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        old_val := to_jsonb(OLD);
        new_val := to_jsonb(NEW);
        INSERT INTO audit_logs (
            event_type, event_category, resource_type, resource_id,
            action, old_value, new_value, created_at
        ) VALUES (
            TG_TABLE_NAME || '_updated', 'data_modification', TG_TABLE_NAME, NEW.id,
            'update', old_val, new_val, CURRENT_TIMESTAMP
        );
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        old_val := to_jsonb(OLD);
        INSERT INTO audit_logs (
            event_type, event_category, resource_type, resource_id,
            action, old_value, created_at
        ) VALUES (
            TG_TABLE_NAME || '_deleted', 'data_modification', TG_TABLE_NAME, OLD.id,
            'delete', old_val, CURRENT_TIMESTAMP
        );
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

-- Apply audit triggers
CREATE TRIGGER audit_memories_changes
    AFTER INSERT OR UPDATE OR DELETE ON memories
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_users_changes
    AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_organizations_changes
    AFTER INSERT OR UPDATE OR DELETE ON organizations
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- Enable Row Level Security
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE user_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE relationships ENABLE ROW LEVEL SECURITY;
ALTER TABLE vector_embeddings ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

-- RLS Policies
CREATE POLICY users_isolation_policy ON users
    FOR ALL USING (
        id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), '')
    );

CREATE POLICY memories_user_isolation_policy ON memories
    FOR ALL USING (
        user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), '')
        OR org_id::TEXT = NULLIF(current_setting('app.current_org_id', TRUE), '')
    );

CREATE POLICY platform_integrations_isolation_policy ON platform_integrations
    FOR ALL USING (user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), ''));

CREATE POLICY sessions_isolation_policy ON sessions
    FOR ALL USING (user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), ''));

CREATE POLICY sync_logs_isolation_policy ON sync_logs
    FOR ALL USING (user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), ''));

-- Utility function
CREATE OR REPLACE FUNCTION set_app_context(
    p_user_id UUID DEFAULT NULL,
    p_org_id UUID DEFAULT NULL
) RETURNS VOID AS $$
BEGIN
    IF p_user_id IS NOT NULL THEN
        PERFORM set_config('app.current_user_id', p_user_id::TEXT, FALSE);
    END IF;
    IF p_org_id IS NOT NULL THEN
        PERFORM set_config('app.current_org_id', p_org_id::TEXT, FALSE);
    END IF;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- DOWN MIGRATION (Rollback)
-- ==========================================

-- To rollback this migration, run:
-- DROP SCHEMA public CASCADE;
-- CREATE SCHEMA public;
-- GRANT ALL ON SCHEMA public TO postgres;
-- GRANT ALL ON SCHEMA public TO public;

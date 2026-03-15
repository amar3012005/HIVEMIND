-- ==========================================
-- DOWN MIGRATION
-- HIVE-MIND Schema Rollback
-- WARNING: This will delete all data
-- ==========================================

-- Drop all triggers first
DROP TRIGGER IF EXISTS audit_memories_changes ON memories;
DROP TRIGGER IF EXISTS audit_users_changes ON users;
DROP TRIGGER IF EXISTS audit_organizations_changes ON organizations;
DROP TRIGGER IF EXISTS update_users_updated_at ON users;
DROP TRIGGER IF EXISTS update_organizations_updated_at ON organizations;
DROP TRIGGER IF EXISTS update_platform_integrations_updated_at ON platform_integrations;
DROP TRIGGER IF EXISTS update_memories_updated_at ON memories;
DROP TRIGGER IF EXISTS update_vector_embeddings_updated_at ON vector_embeddings;

-- Drop all policies (RLS)
DROP POLICY IF EXISTS users_isolation_policy ON users;
DROP POLICY IF EXISTS memories_user_isolation_policy ON memories;
DROP POLICY IF EXISTS platform_integrations_isolation_policy ON platform_integrations;
DROP POLICY IF EXISTS sessions_isolation_policy ON sessions;
DROP POLICY IF EXISTS sync_logs_isolation_policy ON sync_logs;
DROP POLICY IF EXISTS vector_embeddings_isolation_policy ON vector_embeddings;

-- Disable RLS
ALTER TABLE users DISABLE ROW LEVEL SECURITY;
ALTER TABLE organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE user_organizations DISABLE ROW LEVEL SECURITY;
ALTER TABLE platform_integrations DISABLE ROW LEVEL SECURITY;
ALTER TABLE memories DISABLE ROW LEVEL SECURITY;
ALTER TABLE relationships DISABLE ROW LEVEL SECURITY;
ALTER TABLE vector_embeddings DISABLE ROW LEVEL SECURITY;
ALTER TABLE sessions DISABLE ROW LEVEL SECURITY;
ALTER TABLE sync_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs DISABLE ROW LEVEL SECURITY;

-- Drop views
DROP VIEW IF EXISTS active_memories;
DROP VIEW IF EXISTS user_platform_sync_status;

-- Drop functions
DROP FUNCTION IF EXISTS update_updated_at_column() CASCADE;
DROP FUNCTION IF EXISTS audit_trigger_function() CASCADE;
DROP FUNCTION IF EXISTS set_app_context(UUID, UUID) CASCADE;
DROP FUNCTION IF EXISTS encryption.encrypt_with_hsm(TEXT, UUID, INTEGER) CASCADE;
DROP FUNCTION IF EXISTS encryption.decrypt_with_hsm(TEXT, UUID, INTEGER) CASCADE;

-- Drop tables in reverse dependency order
DROP TABLE IF EXISTS data_export_requests CASCADE;
DROP TABLE IF EXISTS audit_logs CASCADE;
DROP TABLE IF EXISTS sync_logs CASCADE;
DROP TABLE IF EXISTS sessions CASCADE;
DROP TABLE IF EXISTS vector_embeddings CASCADE;
DROP TABLE IF EXISTS relationships CASCADE;
DROP TABLE IF EXISTS memories CASCADE;
DROP TABLE IF EXISTS platform_integrations CASCADE;
DROP TABLE IF EXISTS user_organizations CASCADE;
DROP TABLE IF EXISTS organizations CASCADE;
DROP TABLE IF EXISTS users CASCADE;

-- Drop encryption schema
DROP TABLE IF EXISTS encryption.audit_log CASCADE;
DROP SCHEMA IF EXISTS encryption CASCADE;

-- Drop Apache AGE graph
SELECT drop_graph('hivemind_memory_graph', true);

-- Drop enums
DROP TYPE IF EXISTS memory_type CASCADE;
DROP TYPE IF EXISTS relationship_type CASCADE;
DROP TYPE IF EXISTS visibility_scope CASCADE;

-- Drop extensions
DROP EXTENSION IF EXISTS age;
DROP EXTENSION IF EXISTS pgcrypto;
DROP EXTENSION IF EXISTS "uuid-ossp";

-- Reset search path
SET search_path = "$user", public;

-- ==========================================
-- HIVE-MIND Database Initialization Script
-- Runs automatically on first PostgreSQL startup
-- EU Sovereign: GDPR, NIS2, DORA compliant
-- ==========================================

-- This script runs as part of docker-entrypoint-initdb.d
-- It initializes the database with the HIVE-MIND schema

\echo '🌱 Initializing HIVE-MIND database...'

-- Set application context for RLS policies
SET app.hsm_master_key = 'dev_hsm_master_key_for_development_only';

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "age";

-- Load Apache AGE
LOAD 'age';
SET search_path = ag_catalog, "$user", public;

\echo '✅ Extensions enabled'

-- Create encryption schema
CREATE SCHEMA IF NOT EXISTS encryption;

\echo '✅ Encryption schema created'

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

\echo '✅ Enums created'

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

\echo '✅ Encryption audit table created'

-- Create Apache AGE graph
SELECT create_graph('hivemind_memory_graph');

\echo '✅ Apache AGE graph created'

-- Create utility function for RLS context
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

\echo '✅ Utility functions created'

-- Create trigger function for updated_at
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

\echo '✅ Trigger functions created'

\echo '🎉 HIVE-MIND database initialization complete!'
\echo ''
\echo 'Next steps:'
\echo '  1. Run Prisma migrations: npx prisma migrate deploy'
\echo '  2. Seed development data: npm run db:seed'
\echo '  3. Access pgAdmin at: http://localhost:5050'
\echo '     Email: admin@hivemind.local'
\echo '     Password: admin'

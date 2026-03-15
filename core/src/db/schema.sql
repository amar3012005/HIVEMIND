-- ==========================================
-- HIVE-MIND Cross-Platform Schema
-- PostgreSQL 15+ with Apache AGE extension
-- EU Sovereign: LUKS2 encryption, HYOK pattern
-- Compliance: GDPR, NIS2, DORA
-- Data Residency: DE/FR/FI regions only
-- ==========================================

-- ==========================================
-- EXTENSIONS & SCHEMA SETUP
-- ==========================================

-- Enable required PostgreSQL extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "age";

-- Load Apache AGE into shared preload
LOAD 'age';

-- Set search path to include AGE catalog
SET search_path = ag_catalog, "$user", public;

-- Create encryption schema for HYOK pattern
CREATE SCHEMA IF NOT EXISTS encryption;

-- ==========================================
-- ENCRYPTION FUNCTIONS (HYOK Pattern)
-- HSM-backed encryption for EU sovereignty
-- ==========================================

-- Function to encrypt sensitive data with HSM-backed key
-- In production: Fetch key from OVHcloud HSM via KMIP protocol
-- For development: Use pgcrypto with derived key
CREATE OR REPLACE FUNCTION encryption.encrypt_with_hsm(
    plaintext TEXT,
    key_id UUID,
    key_version INTEGER DEFAULT 1
) RETURNS TEXT AS $$
DECLARE
    encrypted_data TEXT;
    key_material BYTEA;
BEGIN
    -- Derive key material from HSM key ID and version
    -- Production: Replace with actual HSM call via KMIP
    key_material := pgp_sym_encrypt(
        key_id::TEXT || ':' || key_version::TEXT,
        current_setting('app.hsm_master_key', TRUE)
    );

    -- Encrypt plaintext with derived key
    encrypted_data := pgp_sym_encrypt(plaintext, key_material::TEXT);

    -- Log encryption event for audit (NIS2/DORA compliance)
    INSERT INTO encryption.audit_log (operation, key_id, key_version, created_at)
    VALUES ('encrypt', key_id, key_version, CURRENT_TIMESTAMP);

    RETURN encrypted_data;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to decrypt sensitive data
CREATE OR REPLACE FUNCTION encryption.decrypt_with_hsm(
    ciphertext TEXT,
    key_id UUID,
    key_version INTEGER DEFAULT 1
) RETURNS TEXT AS $$
DECLARE
    decrypted_data TEXT;
    key_material BYTEA;
BEGIN
    -- Derive key material from HSM key ID and version
    key_material := pgp_sym_encrypt(
        key_id::TEXT || ':' || key_version::TEXT,
        current_setting('app.hsm_master_key', TRUE)
    );

    -- Decrypt ciphertext with derived key
    decrypted_data := pgp_sym_decrypt(ciphertext, key_material::TEXT);

    -- Log decryption event for audit
    INSERT INTO encryption.audit_log (operation, key_id, key_version, created_at)
    VALUES ('decrypt', key_id, key_version, CURRENT_TIMESTAMP);

    RETURN decrypted_data;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Audit log for encryption operations (7-year retention)
CREATE TABLE IF NOT EXISTS encryption.audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    operation VARCHAR(20) NOT NULL CHECK (operation IN ('encrypt', 'decrypt', 'key_rotation')),
    key_id UUID NOT NULL,
    key_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_encryption_audit_key ON encryption.audit_log(key_id);
CREATE INDEX IF NOT EXISTS idx_encryption_audit_time ON encryption.audit_log(created_at DESC);

-- ==========================================
-- USERS & ORGANIZATIONS (Multi-tenant Foundation)
-- GDPR-ready with soft delete and data residency
-- ==========================================

CREATE TABLE IF NOT EXISTS users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    zitadel_user_id VARCHAR(255) UNIQUE NOT NULL,  -- External IAM reference (ZITADEL)
    email VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    avatar_url TEXT,
    timezone VARCHAR(50) DEFAULT 'UTC',
    locale VARCHAR(10) DEFAULT 'en',

    -- HYOK encryption keys (user-specific)
    encryption_key_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    encryption_key_version INTEGER DEFAULT 1,

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,  -- Soft delete for GDPR right to erasure

    CONSTRAINT chk_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    zitadel_org_id VARCHAR(255) UNIQUE NOT NULL,  -- External IAM reference
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,

    -- Compliance flags
    data_residency_region VARCHAR(50) DEFAULT 'eu-central',  -- eu-central, eu-west, eu-north
    compliance_flags TEXT[] DEFAULT ARRAY['GDPR', 'NIS2', 'DORA'],

    -- HYOK configuration
    hsm_provider VARCHAR(50) DEFAULT 'ovhcloud',  -- ovhcloud, thales, utimaco
    hsm_key_arn VARCHAR(255),

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Junction table for user-organization many-to-many relationship
CREATE TABLE IF NOT EXISTS user_organizations (
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member',  -- owner, admin, member, viewer
    invited_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    joined_at TIMESTAMPTZ,

    PRIMARY KEY (user_id, org_id)
);

-- Indexes for user-organization lookups
CREATE INDEX IF NOT EXISTS idx_user_organizations_user ON user_organizations(user_id);
CREATE INDEX IF NOT EXISTS idx_user_organizations_org ON user_organizations(org_id);

-- ==========================================
-- PLATFORM INTEGRATIONS (Cross-platform Auth)
-- OAuth2, API keys, webhooks for AI platforms
-- ==========================================

CREATE TABLE IF NOT EXISTS platform_integrations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,

    -- Platform identification
    platform_type VARCHAR(50) NOT NULL,  -- chatgpt, claude, perplexity, gemini
    platform_user_id VARCHAR(255),  -- External platform's user ID
    platform_display_name VARCHAR(255),

    -- Authentication (encrypted fields for security)
    auth_type VARCHAR(50) NOT NULL,  -- oauth2, api_key, webhook
    access_token_encrypted TEXT,  -- LUKS2 encrypted access token
    refresh_token_encrypted TEXT,  -- LUKS2 encrypted refresh token
    token_expires_at TIMESTAMPTZ,
    api_key_hash VARCHAR(255),  -- SHA-256 hash for API key verification
    webhook_secret_encrypted TEXT,  -- Encrypted webhook signing secret

    -- OAuth metadata
    oauth_scopes TEXT[],
    oauth_granted_at TIMESTAMPTZ,
    oauth_last_refreshed TIMESTAMPTZ,

    -- Status tracking
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMPTZ,
    sync_status VARCHAR(50) DEFAULT 'idle',  -- idle, syncing, error, revoked

    -- Error tracking (for health monitoring)
    last_error_message TEXT,
    last_error_at TIMESTAMPTZ,
    consecutive_failures INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(user_id, platform_type)
);

-- Indexes for platform integration queries
CREATE INDEX IF NOT EXISTS idx_platform_integrations_user ON platform_integrations(user_id);
CREATE INDEX IF NOT EXISTS idx_platform_integrations_type ON platform_integrations(platform_type);
CREATE INDEX IF NOT EXISTS idx_platform_integrations_status ON platform_integrations(is_active, sync_status);

-- ==========================================
-- MEMORIES (Core table with triple-operator support)
-- Graph-based memory with versioning and cognitive scoring
-- ==========================================

-- Memory type enumeration
DO $$ BEGIN
    CREATE TYPE memory_type AS ENUM ('fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Relationship type enumeration (triple-operator)
DO $$ BEGIN
    CREATE TYPE relationship_type AS ENUM ('Updates', 'Extends', 'Derives');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

-- Visibility scope enumeration
DO $$ BEGIN
    CREATE TYPE visibility_scope AS ENUM ('private', 'organization', 'public');
EXCEPTION
    WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    project VARCHAR(255),  -- Project/workspace context for multi-tenant isolation

    -- Content
    content TEXT NOT NULL,
    memory_type memory_type DEFAULT 'fact',
    title VARCHAR(500),  -- Auto-generated summary
    tags TEXT[],  -- User-defined tags for categorization

    -- Source tracking (cross-platform origin)
    source_platform VARCHAR(50),  -- chatgpt, claude, etc.
    source_session_id VARCHAR(255),  -- Platform's session ID
    source_message_id VARCHAR(255),  -- Platform's message ID
    source_url TEXT,  -- If from web context

    -- Triple-operator relationships (versioning)
    is_latest BOOLEAN DEFAULT TRUE,  -- For Updates relationship
    supersedes_id UUID REFERENCES memories(id),  -- Points to memory this updates

    -- Cognitive scoring (Ebbinghaus forgetting curve)
    strength REAL DEFAULT 1.0,  -- Memory strength for spaced repetition
    recall_count INTEGER DEFAULT 0,  -- Number of times recalled
    importance_score REAL DEFAULT 0.5,  -- User/model assigned importance
    last_confirmed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    -- Temporal grounding (dual-layer timestamps)
    document_date TIMESTAMPTZ,  -- When the interaction occurred
    event_dates TIMESTAMPTZ[],  -- When referenced events occurred

    -- Visibility & sharing
    visibility visibility_scope DEFAULT 'private',
    shared_with_orgs UUID[],  -- Organization IDs for org-level visibility

    -- Vector search metadata
    embedding_model VARCHAR(100) DEFAULT 'mistral-embed',
    embedding_dimension INTEGER DEFAULT 1024,
    embedding_version INTEGER DEFAULT 1,

    -- GDPR compliance
    processing_basis VARCHAR(100) DEFAULT 'consent',  -- GDPR Article 6 basis
    retention_until TIMESTAMPTZ,  -- For data retention policies
    export_blocked BOOLEAN DEFAULT FALSE,  -- For legal holds

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ  -- Soft delete for GDPR
);

-- Performance indexes for memory queries
CREATE INDEX IF NOT EXISTS idx_memories_user ON memories(user_id);
CREATE INDEX IF NOT EXISTS idx_memories_org ON memories(org_id);
CREATE INDEX IF NOT EXISTS idx_memories_project ON memories(project);
CREATE INDEX IF NOT EXISTS idx_memories_type ON memories(memory_type);
CREATE INDEX IF NOT EXISTS idx_memories_latest ON memories(is_latest) WHERE is_latest = TRUE;
CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source_platform);
CREATE INDEX IF NOT EXISTS idx_memories_document_date ON memories(document_date DESC);
CREATE INDEX IF NOT EXISTS idx_memories_strength ON memories(strength DESC);
CREATE INDEX IF NOT EXISTS idx_memories_deleted ON memories(deleted_at) WHERE deleted_at IS NOT NULL;

-- Full-text search index (for hybrid search fallback)
CREATE INDEX IF NOT EXISTS idx_memories_content_fts ON memories USING GIN (to_tsvector('english', content));

-- Tags GIN index for array containment queries
CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories USING GIN (tags);

-- ==========================================
-- RELATIONSHIPS (Graph edges)
-- Explicit relationship tracking for graph traversal
-- ==========================================

CREATE TABLE IF NOT EXISTS relationships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    to_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    type relationship_type NOT NULL,

    -- Confidence scoring
    confidence REAL DEFAULT 1.0,
    inference_model VARCHAR(100),  -- Model that derived this relationship
    inference_prompt_hash VARCHAR(64),  -- SHA-256 hash for audit/reproducibility

    -- Metadata (flexible JSONB for extensibility)
    metadata JSONB DEFAULT '{}',
    created_by VARCHAR(50) DEFAULT 'system',  -- system, user, model

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(from_id, to_id, type)
);

-- Indexes for graph traversal performance
CREATE INDEX IF NOT EXISTS idx_relationships_from ON relationships(from_id);
CREATE INDEX IF NOT EXISTS idx_relationships_to ON relationships(to_id);
CREATE INDEX IF NOT EXISTS idx_relationships_type ON relationships(type);
CREATE INDEX IF NOT EXISTS idx_relationships_from_type ON relationships(from_id, type);
CREATE INDEX IF NOT EXISTS idx_relationships_to_type ON relationships(to_id, type);
CREATE INDEX IF NOT EXISTS idx_relationships_metadata ON relationships USING GIN (metadata);

-- ==========================================
-- VECTOR EMBEDDINGS (Qdrant sync metadata)
-- Tracks synchronization between PostgreSQL and Qdrant
-- ==========================================

CREATE TABLE IF NOT EXISTS vector_embeddings (
    memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    qdrant_collection VARCHAR(100) NOT NULL,
    qdrant_point_id UUID NOT NULL,

    -- Versioning for re-embedding
    embedding_version INTEGER DEFAULT 1,
    last_reembedded_at TIMESTAMPTZ,

    -- Sync status tracking
    sync_status VARCHAR(50) DEFAULT 'synced',  -- synced, pending, failed
    last_sync_attempt TIMESTAMPTZ,
    sync_error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_vector_embeddings_sync ON vector_embeddings(sync_status, last_sync_attempt);

-- ==========================================
-- SESSIONS (Cross-platform session tracking)
-- Tracks user sessions across all AI platforms
-- ==========================================

CREATE TABLE IF NOT EXISTS sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,

    -- Platform context
    platform_type VARCHAR(50) NOT NULL,  -- chatgpt, claude, etc.
    platform_session_id VARCHAR(255),  -- External session ID

    -- Session metadata
    title VARCHAR(500),  -- Auto-generated session title
    message_count INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,

    -- Context injection tracking
    memories_injected UUID[],  -- Memory IDs injected into this session
    context_window_used INTEGER DEFAULT 0,
    compaction_triggered BOOLEAN DEFAULT FALSE,

    -- Lifecycle
    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_activity_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    end_reason VARCHAR(50),  -- user_closed, timeout, compaction, error

    -- Auto-captured decisions/lessons
    auto_captured_count INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for session queries
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_sessions_platform ON sessions(platform_type);
CREATE INDEX IF NOT EXISTS idx_sessions_active ON sessions(user_id, ended_at) WHERE ended_at IS NULL;

-- ==========================================
-- SYNC LOGS (Audit trail for cross-platform sync)
-- NIS2/DORA compliance: track all sync events
-- ==========================================

CREATE TABLE IF NOT EXISTS sync_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,

    -- Sync event details
    event_type VARCHAR(50) NOT NULL,  -- memory_created, memory_updated, context_synced
    source_platform VARCHAR(50),
    target_platform VARCHAR(50),

    -- Payload reference
    memory_ids UUID[],
    session_id UUID REFERENCES sessions(id),
    payload_hash VARCHAR(64),  -- SHA-256 of sync payload

    -- Result tracking
    status VARCHAR(50) DEFAULT 'success',  -- success, failed, partial
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,

    -- Timing
    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    latency_ms INTEGER
);

-- Indexes for sync log queries
CREATE INDEX IF NOT EXISTS idx_sync_logs_user ON sync_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_sync_logs_event ON sync_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_sync_logs_time ON sync_logs(started_at DESC);

-- ==========================================
-- APACHE AGE GRAPH SETUP
-- Graph database for complex relationship queries
-- ==========================================

-- Create the main memory graph
SELECT create_graph('hivemind_memory_graph');

-- Example Cypher query for Derives relationships:
-- SELECT * FROM cypher('hivemind_memory_graph', $$
--   MATCH (m1:Memory)-[:Derives*1..3]->(m2:Memory)
--   WHERE m1.user_id = 'uuid-here'
--   RETURN m1, m2, relationships(m1, m2)
-- $$) AS (m1 agtype, m2 agtype, rels agtype);

-- ==========================================
-- VIEWS FOR COMMON QUERIES
-- ==========================================

-- Active memories view (latest versions only, not deleted)
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

-- Cross-platform sync status view
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

-- ==========================================
-- GDPR: DATA EXPORT/ERASURE
-- Support GDPR right to portability and erasure
-- ==========================================

CREATE TABLE IF NOT EXISTS data_export_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    request_type VARCHAR(50) NOT NULL,  -- export, erasure, portability
    status VARCHAR(50) DEFAULT 'pending',  -- pending, processing, completed, failed
    export_format VARCHAR(20) DEFAULT 'json',  -- json, csv, parquet
    export_url TEXT,  -- Signed URL for download (expires in 24h)
    requested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    error_message TEXT
);

-- ==========================================
-- AUDIT LOGGING (NIS2/DORA: 7-year retention)
-- Comprehensive audit trail for compliance
-- ==========================================

CREATE TABLE IF NOT EXISTS audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,

    -- Event details
    event_type VARCHAR(100) NOT NULL,
    event_category VARCHAR(50),  -- auth, data_access, data_modification, system
    resource_type VARCHAR(50),  -- memory, user, organization, integration
    resource_id UUID,

    -- Action details
    action VARCHAR(50) NOT NULL,  -- create, read, update, delete, export, erase
    old_value JSONB,  -- Before state (for updates/deletes)
    new_value JSONB,  -- After state (for creates/updates)

    -- Context
    ip_address INET,
    user_agent TEXT,
    platform_type VARCHAR(50),
    session_id UUID,

    -- Compliance
    processing_basis VARCHAR(100),  -- GDPR Article 6
    legal_basis_note TEXT,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for audit log queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_event ON audit_logs(event_type);
CREATE INDEX IF NOT EXISTS idx_audit_logs_time ON audit_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource ON audit_logs(resource_type, resource_id);
CREATE INDEX IF NOT EXISTS idx_audit_logs_action ON audit_logs(action);

-- ==========================================
-- TRIGGERS FOR AUTOMATIC TIMESTAMP UPDATES
-- ==========================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply trigger to all tables with updated_at
CREATE TRIGGER update_users_updated_at
    BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_organizations_updated_at
    BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_platform_integrations_updated_at
    BEFORE UPDATE ON platform_integrations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_memories_updated_at
    BEFORE UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_vector_embeddings_updated_at
    BEFORE UPDATE ON vector_embeddings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ==========================================
-- AUDIT LOG TRIGGER FUNCTION
-- Automatically log all changes to audited tables
-- ==========================================

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

-- Apply audit triggers to critical tables (NIS2/DORA compliance)
CREATE TRIGGER audit_memories_changes
    AFTER INSERT OR UPDATE OR DELETE ON memories
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_users_changes
    AFTER INSERT OR UPDATE OR DELETE ON users
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

CREATE TRIGGER audit_organizations_changes
    AFTER INSERT OR UPDATE OR DELETE ON organizations
    FOR EACH ROW EXECUTE FUNCTION audit_trigger_function();

-- ==========================================
-- ROW LEVEL SECURITY (RLS) POLICIES
-- Multi-tenant isolation at database level
-- ==========================================

-- Enable RLS on all tenant tables
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

-- RLS Policies for users table
CREATE POLICY users_isolation_policy ON users
    FOR ALL
    USING (
        -- Allow access if user_id matches the authenticated user
        id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), '')
        OR
        -- Allow organization admins to view members
        EXISTS (
            SELECT 1 FROM user_organizations uo
            JOIN organizations o ON uo.org_id = o.id
            WHERE uo.user_id = users.id
            AND uo.role IN ('owner', 'admin')
            AND uo.org_id::TEXT = NULLIF(current_setting('app.current_org_id', TRUE), '')
        )
    );

-- RLS Policies for memories table (core multi-tenant isolation)
CREATE POLICY memories_user_isolation_policy ON memories
    FOR ALL
    USING (
        -- User can access their own memories
        user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), '')
        OR
        -- Organization members can access org-shared memories
        (
            org_id::TEXT = NULLIF(current_setting('app.current_org_id', TRUE), '')
            AND visibility IN ('organization', 'public')
        )
        OR
        -- Public memories are accessible to all
        visibility = 'public'
    );

-- RLS Policies for platform_integrations
CREATE POLICY platform_integrations_isolation_policy ON platform_integrations
    FOR ALL
    USING (user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), ''));

-- RLS Policies for sessions
CREATE POLICY sessions_isolation_policy ON sessions
    FOR ALL
    USING (user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), ''));

-- RLS Policies for sync_logs
CREATE POLICY sync_logs_isolation_policy ON sync_logs
    FOR ALL
    USING (user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), ''));

-- RLS Policies for vector_embeddings (follows memory ownership)
CREATE POLICY vector_embeddings_isolation_policy ON vector_embeddings
    FOR ALL
    USING (
        EXISTS (
            SELECT 1 FROM memories m
            WHERE m.id = vector_embeddings.memory_id
            AND (
                m.user_id::TEXT = NULLIF(current_setting('app.current_user_id', TRUE), '')
                OR m.org_id::TEXT = NULLIF(current_setting('app.current_org_id', TRUE), '')
            )
        )
    );

-- ==========================================
-- UTILITY FUNCTIONS
-- ==========================================

-- Function to set application context for RLS
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

-- Function to get active memories with cognitive scoring
CREATE OR REPLACE FUNCTION get_relevant_memories(
    p_user_id UUID,
    p_memory_types memory_type[] DEFAULT NULL,
    p_limit INTEGER DEFAULT 20
) RETURNS TABLE (
    id UUID,
    content TEXT,
    memory_type memory_type,
    strength REAL,
    importance_score REAL,
    recall_count INTEGER,
    document_date TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT
        m.id,
        m.content,
        m.memory_type,
        m.strength,
        m.importance_score,
        m.recall_count,
        m.document_date
    FROM memories m
    WHERE m.user_id = p_user_id
      AND m.is_latest = TRUE
      AND m.deleted_at IS NULL
      AND (p_memory_types IS NULL OR m.memory_type = ANY(p_memory_types))
    ORDER BY
        -- Recency bias with cognitive scoring
        (m.strength * m.importance_score) DESC,
        m.document_date DESC
    LIMIT p_limit;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- SCHEMA DOCUMENTATION COMMENTS
-- ==========================================

COMMENT ON TABLE users IS 'User accounts with ZITADEL IAM integration and HYOK encryption keys';
COMMENT ON TABLE organizations IS 'Multi-tenant organizations with EU data residency settings';
COMMENT ON TABLE memories IS 'Core memory storage with triple-operator versioning and cognitive scoring';
COMMENT ON TABLE relationships IS 'Graph edges between memories (Updates, Extends, Derives)';
COMMENT ON TABLE platform_integrations IS 'OAuth2/API key integrations with AI platforms (ChatGPT, Claude, etc.)';
COMMENT ON TABLE vector_embeddings IS 'Qdrant vector sync metadata for semantic search';
COMMENT ON TABLE sessions IS 'Cross-platform session tracking for context preservation';
COMMENT ON TABLE audit_logs IS 'NIS2/DORA compliance audit trail with 7-year retention';
COMMENT ON SCHEMA encryption IS 'HYOK encryption functions and key management audit';

-- ==========================================
-- END OF SCHEMA
-- ==========================================

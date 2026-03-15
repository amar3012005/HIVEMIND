-- ==========================================
-- AUDIT LOGGING TRIGGERS MIGRATION
-- HIVE-MIND Cross-Platform Context Sync
-- PostgreSQL 15+ with Apache AGE
-- 
-- Automatic audit logging via database triggers
-- - Memory CRUD operations
-- - API key usage tracking
-- - 7-year retention (NIS2/DORA compliance)
--
-- Compliance: GDPR, NIS2, DORA
-- Retention: 7 years from event date
-- ==========================================

-- ==========================================
-- AUDIT LOGGING FUNCTION
-- Generic function to create audit log entries
-- ==========================================

CREATE OR REPLACE FUNCTION hivemind.create_audit_log_entry(
    p_user_id UUID,
    p_organization_id UUID,
    p_event_type VARCHAR,
    p_event_category VARCHAR,
    p_resource_type VARCHAR,
    p_resource_id UUID,
    p_action VARCHAR,
    p_old_value JSONB DEFAULT NULL,
    p_new_value JSONB DEFAULT NULL,
    p_ip_address INET DEFAULT NULL,
    p_user_agent TEXT DEFAULT NULL,
    p_platform_type VARCHAR DEFAULT NULL,
    p_session_id UUID DEFAULT NULL
) RETURNS UUID AS $$
DECLARE
    v_audit_id UUID;
BEGIN
    INSERT INTO hivemind.audit_logs (
        id,
        user_id,
        organization_id,
        event_type,
        event_category,
        resource_type,
        resource_id,
        action,
        old_value,
        new_value,
        ip_address,
        user_agent,
        platform_type,
        session_id,
        created_at
    ) VALUES (
        gen_random_uuid(),
        p_user_id,
        p_organization_id,
        p_event_type,
        p_event_category,
        p_resource_type,
        p_resource_id,
        p_action,
        p_old_value,
        p_new_value,
        p_ip_address,
        p_user_agent,
        p_platform_type,
        p_session_id,
        CURRENT_TIMESTAMP
    ) RETURNING id INTO v_audit_id;

    RETURN v_audit_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- MEMORY TRIGGERS
-- Auto-log memory CRUD operations
-- ==========================================

-- Function to log memory INSERT
CREATE OR REPLACE FUNCTION hivemind.audit_memory_insert()
RETURNS TRIGGER AS $$
BEGIN
    -- Log memory creation
    PERFORM hivemind.create_audit_log_entry(
        p_user_id := NEW.user_id,
        p_organization_id := NEW.org_id,
        p_event_type := 'memory_created',
        p_event_category := 'data_modification',
        p_resource_type := 'memory',
        p_resource_id := NEW.id,
        p_action := 'create',
        p_new_value := jsonb_build_object(
            'content', LEFT(NEW.content, 1000),  -- Truncate for audit log
            'memory_type', NEW.memory_type,
            'title', NEW.title,
            'tags', NEW.tags,
            'source_platform', NEW.source_platform,
            'visibility', NEW.visibility
        ),
        p_ip_address := NULL,  -- Will be set by application layer
        p_user_agent := NULL,
        p_platform_type := NEW.source_platform
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to log memory UPDATE
CREATE OR REPLACE FUNCTION hivemind.audit_memory_update()
RETURNS TRIGGER AS $$
DECLARE
    v_changes JSONB;
BEGIN
    -- Build change summary
    v_changes := jsonb_build_object(
        'changed_fields', (
            SELECT jsonb_object_agg(key, value)
            FROM jsonb_each(to_jsonb(NEW) - 'updated_at' - 'id' - 'created_at')
            WHERE value IS DISTINCT FROM (to_jsonb(OLD) - 'updated_at' - 'id' - 'created_at')->>key
        ),
        'old_values', (
            SELECT jsonb_object_agg(key, value)
            FROM jsonb_each(to_jsonb(OLD) - 'updated_at' - 'id' - 'created_at')
            WHERE value IS DISTINCT FROM (to_jsonb(NEW) - 'updated_at' - 'id' - 'created_at')->>key
        )
    );

    -- Log memory update
    PERFORM hivemind.create_audit_log_entry(
        p_user_id := COALESCE(NEW.user_id, OLD.user_id),
        p_organization_id := COALESCE(NEW.org_id, OLD.org_id),
        p_event_type := 'memory_updated',
        p_event_category := 'data_modification',
        p_resource_type := 'memory',
        p_resource_id := NEW.id,
        p_action := 'update',
        p_old_value := jsonb_build_object(
            'content', LEFT(OLD.content, 1000),
            'memory_type', OLD.memory_type,
            'title', OLD.title,
            'tags', OLD.tags,
            'is_latest', OLD.is_latest
        ),
        p_new_value := jsonb_build_object(
            'content', LEFT(NEW.content, 1000),
            'memory_type', NEW.memory_type,
            'title', NEW.title,
            'tags', NEW.tags,
            'is_latest', NEW.is_latest,
            'supersedes_id', NEW.supersedes_id
        ),
        p_platform_type := NEW.source_platform
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to log memory DELETE (soft delete)
CREATE OR REPLACE FUNCTION hivemind.audit_memory_delete()
RETURNS TRIGGER AS $$
BEGIN
    -- Log memory deletion
    PERFORM hivemind.create_audit_log_entry(
        p_user_id := OLD.user_id,
        p_organization_id := OLD.org_id,
        p_event_type := 'memory_deleted',
        p_event_category := 'data_modification',
        p_resource_type := 'memory',
        p_resource_id := OLD.id,
        p_action := 'delete',
        p_old_value := jsonb_build_object(
            'content', LEFT(OLD.content, 1000),
            'memory_type', OLD.memory_type,
            'title', OLD.title,
            'tags', OLD.tags,
            'deleted_at', OLD.deleted_at
        ),
        p_platform_type := OLD.source_platform
    );

    RETURN OLD;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create memory triggers
DROP TRIGGER IF EXISTS trg_audit_memory_insert ON hivemind.memories;
CREATE TRIGGER trg_audit_memory_insert
    AFTER INSERT ON hivemind.memories
    FOR EACH ROW
    EXECUTE FUNCTION hivemind.audit_memory_insert();

DROP TRIGGER IF EXISTS trg_audit_memory_update ON hivemind.memories;
CREATE TRIGGER trg_audit_memory_update
    AFTER UPDATE ON hivemind.memories
    FOR EACH ROW
    WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION hivemind.audit_memory_update();

DROP TRIGGER IF EXISTS trg_audit_memory_delete ON hivemind.memories;
CREATE TRIGGER trg_audit_memory_delete
    AFTER UPDATE ON hivemind.memories
    FOR EACH ROW
    WHEN (NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL)
    EXECUTE FUNCTION hivemind.audit_memory_delete();

-- ==========================================
-- API KEY TRIGGERS
-- Auto-log API key usage and lifecycle
-- ==========================================

-- Function to log API key INSERT
CREATE OR REPLACE FUNCTION hivemind.audit_api_key_insert()
RETURNS TRIGGER AS $$
BEGIN
    -- Log API key creation
    PERFORM hivemind.create_audit_log_entry(
        p_user_id := NEW.user_id,
        p_organization_id := NEW.org_id,
        p_event_type := 'api_key_created',
        p_event_category := 'security',
        p_resource_type := 'api_key',
        p_resource_id := NEW.id,
        p_action := 'create',
        p_new_value := jsonb_build_object(
            'name', NEW.name,
            'key_prefix', NEW.key_prefix,
            'scopes', NEW.scopes,
            'expires_at', NEW.expires_at,
            'rate_limit_per_minute', NEW.rate_limit_per_minute
        ),
        p_ip_address := NEW.created_by_ip,
        p_user_agent := NEW.user_agent
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to log API key UPDATE (revocation, usage)
CREATE OR REPLACE FUNCTION hivemind.audit_api_key_update()
RETURNS TRIGGER AS $$
DECLARE
    v_event_type VARCHAR;
    v_action VARCHAR;
BEGIN
    -- Determine event type based on what changed
    IF NEW.revoked_at IS NOT NULL AND OLD.revoked_at IS NULL THEN
        v_event_type := 'api_key_revoked';
        v_action := 'api_key_revoked';
    ELSIF NEW.last_used_at IS NOT NULL AND OLD.last_used_at IS DISTINCT FROM NEW.last_used_at THEN
        v_event_type := 'api_key_used';
        v_action := 'api_key_used';
    ELSE
        v_event_type := 'api_key_updated';
        v_action := 'update';
    END IF;

    -- Log API key update
    PERFORM hivemind.create_audit_log_entry(
        p_user_id := NEW.user_id,
        p_organization_id := NEW.org_id,
        p_event_type := v_event_type,
        p_event_category := 'security',
        p_resource_type := 'api_key',
        p_resource_id := NEW.id,
        p_action := v_action,
        p_old_value := CASE 
            WHEN v_action = 'api_key_revoked' THEN jsonb_build_object(
                'revoked_at', OLD.revoked_at,
                'usage_count', OLD.usage_count
            )
            ELSE NULL
        END,
        p_new_value := CASE 
            WHEN v_action = 'api_key_revoked' THEN jsonb_build_object(
                'revoked_at', NEW.revoked_at,
                'revoked_reason', NEW.revoked_reason
            )
            WHEN v_action = 'api_key_used' THEN jsonb_build_object(
                'last_used_at', NEW.last_used_at,
                'usage_count', NEW.usage_count
            )
            ELSE jsonb_build_object(
                'name', NEW.name,
                'scopes', NEW.scopes,
                'expires_at', NEW.expires_at
            )
        END
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create API key triggers
DROP TRIGGER IF EXISTS trg_audit_api_key_insert ON hivemind.api_keys;
CREATE TRIGGER trg_audit_api_key_insert
    AFTER INSERT ON hivemind.api_keys
    FOR EACH ROW
    EXECUTE FUNCTION hivemind.audit_api_key_insert();

DROP TRIGGER IF EXISTS trg_audit_api_key_update ON hivemind.api_keys;
CREATE TRIGGER trg_audit_api_key_update
    AFTER UPDATE ON hivemind.api_keys
    FOR EACH ROW
    WHEN (OLD.* IS DISTINCT FROM NEW.*)
    EXECUTE FUNCTION hivemind.audit_api_key_update();

-- ==========================================
-- DATA EXPORT/ERASURE TRIGGERS
-- Auto-log GDPR data export/erasure requests
-- ==========================================

-- Function to log data export/erasure requests
CREATE OR REPLACE FUNCTION hivemind.audit_data_export_request()
RETURNS TRIGGER AS $$
DECLARE
    v_event_type VARCHAR;
    v_action VARCHAR;
BEGIN
    -- Determine event type based on request type
    IF NEW.request_type = 'export' THEN
        v_event_type := 'export_request';
        v_action := 'export';
    ELSIF NEW.request_type = 'erasure' THEN
        v_event_type := 'erase_request';
        v_action := 'erase';
    ELSE
        v_event_type := 'portability_request';
        v_action := 'export';
    END IF;

    -- Log export/erasure request
    PERFORM hivemind.create_audit_log_entry(
        p_user_id := NEW.user_id,
        p_organization_id := NULL,  -- User-level operation
        p_event_type := v_event_type,
        p_event_category := 'compliance',
        p_resource_type := 'export_request',
        p_resource_id := NEW.id,
        p_action := v_action,
        p_new_value := jsonb_build_object(
            'request_type', NEW.request_type,
            'status', NEW.status,
            'export_format', NEW.export_format,
            'requested_at', NEW.requested_at
        ),
        p_ip_address := NULL,  -- Will be set by application layer
        p_user_agent := NULL
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create data export trigger
DROP TRIGGER IF EXISTS trg_audit_data_export_request ON hivemind.data_export_requests;
CREATE TRIGGER trg_audit_data_export_request
    AFTER INSERT ON hivemind.data_export_requests
    FOR EACH ROW
    EXECUTE FUNCTION hivemind.audit_data_export_request();

-- ==========================================
-- USER SESSION TRIGGERS
-- Log user session events
-- ==========================================

-- Function to log session events
CREATE OR REPLACE FUNCTION hivemind.audit_session_event()
RETURNS TRIGGER AS $$
DECLARE
    v_event_type VARCHAR;
    v_action VARCHAR;
BEGIN
    -- Determine event type based on session state
    IF NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL THEN
        v_event_type := 'session_ended';
        v_action := 'logout';
    ELSIF NEW.last_activity_at IS NOT NULL AND OLD.last_activity_at IS DISTINCT FROM NEW.last_activity_at THEN
        v_event_type := 'session_activity';
        v_action := 'read';
    ELSE
        v_event_type := 'session_started';
        v_action := 'login';
    END IF;

    -- Log session event
    PERFORM hivemind.create_audit_log_entry(
        p_user_id := NEW.user_id,
        p_organization_id := NULL,
        p_event_type := v_event_type,
        p_event_category := 'auth',
        p_resource_type := 'session',
        p_resource_id := NEW.id,
        p_action := v_action,
        p_new_value := jsonb_build_object(
            'platform_type', NEW.platform_type,
            'platform_session_id', NEW.platform_session_id,
            'message_count', NEW.message_count,
            'token_count', NEW.token_count,
            'ended_at', NEW.ended_at,
            'end_reason', NEW.end_reason
        )
    );

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Create session trigger
DROP TRIGGER IF EXISTS trg_audit_session_event ON hivemind.sessions;
CREATE TRIGGER trg_audit_session_event
    AFTER INSERT OR UPDATE ON hivemind.sessions
    FOR EACH ROW
    EXECUTE FUNCTION hivemind.audit_session_event();

-- ==========================================
-- RETENTION POLICY FUNCTION
-- Automatic 7-year retention enforcement
-- ==========================================

CREATE OR REPLACE FUNCTION hivemind.enforce_audit_retention_policy()
RETURNS VOID AS $$
DECLARE
    v_cutoff_date TIMESTAMPTZ;
    v_archived_count INTEGER;
BEGIN
    -- Calculate cutoff date (7 years ago)
    v_cutoff_date := CURRENT_TIMESTAMP - INTERVAL '7 years';

    -- Mark old logs for archival (don't delete for compliance)
    UPDATE hivemind.audit_logs
    SET 
        archived_at = CURRENT_TIMESTAMP,
        archived_version = 1,
        archive_location = '/archive/audit-logs/' || TO_CHAR(CURRENT_TIMESTAMP, 'YYYY/MM/DD') || '/' || id::TEXT
    WHERE created_at < v_cutoff_date
      AND archived_at IS NULL;

    GET DIAGNOSTICS v_archived_count = ROW_COUNT;

    -- Log retention enforcement
    RAISE NOTICE 'Audit retention policy enforced: % records archived (cutoff: %)', 
        v_archived_count, v_cutoff_date;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- AUDIT LOG STATISTICS VIEW
-- Pre-computed statistics for quick access
-- ==========================================

CREATE OR REPLACE VIEW hivemind.audit_log_stats AS
SELECT
    -- Overall counts
    COUNT(*) AS total_logs,
    COUNT(*) FILTER (WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '24 hours') AS logs_last_24h,
    COUNT(*) FILTER (WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '7 days') AS logs_last_7d,
    COUNT(*) FILTER (WHERE created_at >= CURRENT_TIMESTAMP - INTERVAL '30 days') AS logs_last_30d,
    
    -- By category
    COUNT(*) FILTER (WHERE event_category = 'auth') AS auth_events,
    COUNT(*) FILTER (WHERE event_category = 'data_access') AS data_access_events,
    COUNT(*) FILTER (WHERE event_category = 'data_modification') AS data_modification_events,
    COUNT(*) FILTER (WHERE event_category = 'security') AS security_events,
    COUNT(*) FILTER (WHERE event_category = 'compliance') AS compliance_events,
    
    -- By action
    COUNT(*) FILTER (WHERE action = 'create') AS create_actions,
    COUNT(*) FILTER (WHERE action = 'read') AS read_actions,
    COUNT(*) FILTER (WHERE action = 'update') AS update_actions,
    COUNT(*) FILTER (WHERE action = 'delete') AS delete_actions,
    
    -- Retention status
    COUNT(*) FILTER (WHERE archived_at IS NOT NULL) AS archived_logs,
    COUNT(*) FILTER (WHERE created_at < CURRENT_TIMESTAMP - INTERVAL '7 years' AND archived_at IS NULL) AS pending_archival
FROM hivemind.audit_logs;

-- ==========================================
-- INDEXES FOR PERFORMANCE
-- Optimize audit log queries
-- ==========================================

-- Composite index for common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_logs_user_org_time 
    ON hivemind.audit_logs(user_id, organization_id, created_at DESC);

-- Index for resource-based queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_resource_time 
    ON hivemind.audit_logs(resource_type, resource_id, created_at DESC);

-- Index for event type queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_event_type_time 
    ON hivemind.audit_logs(event_type, created_at DESC);

-- Index for action-based queries
CREATE INDEX IF NOT EXISTS idx_audit_logs_action_time 
    ON hivemind.audit_logs(action, created_at DESC);

-- Partial index for unarchived logs (faster recent queries)
CREATE INDEX IF NOT EXISTS idx_audit_logs_active 
    ON hivemind.audit_logs(created_at DESC)
    WHERE archived_at IS NULL;

-- ==========================================
-- COMMENTS FOR DOCUMENTATION
-- ==========================================

COMMENT ON FUNCTION hivemind.create_audit_log_entry IS 
    'Creates an audit log entry for NIS2/DORA compliance. Returns the audit log ID.';

COMMENT ON FUNCTION hivemind.audit_memory_insert IS 
    'Trigger function to automatically log memory creation events.';

COMMENT ON FUNCTION hivemind.audit_memory_update IS 
    'Trigger function to automatically log memory update events with change tracking.';

COMMENT ON FUNCTION hivemind.audit_memory_delete IS 
    'Trigger function to automatically log memory soft-delete events.';

COMMENT ON FUNCTION hivemind.audit_api_key_insert IS 
    'Trigger function to automatically log API key creation events.';

COMMENT ON FUNCTION hivemind.audit_api_key_update IS 
    'Trigger function to automatically log API key lifecycle events (usage, revocation).';

COMMENT ON FUNCTION hivemind.audit_data_export_request IS 
    'Trigger function to automatically log GDPR data export/erasure requests.';

COMMENT ON FUNCTION hivemind.audit_session_event IS 
    'Trigger function to automatically log user session events (login, logout).';

COMMENT ON FUNCTION hivemind.enforce_audit_retention_policy IS 
    'Enforces 7-year retention policy by marking old audit logs for archival.';

COMMENT ON VIEW hivemind.audit_log_stats IS 
    'Pre-computed statistics view for audit log monitoring and compliance reporting.';

-- ==========================================
-- MIGRATION COMPLETE
-- ==========================================

DO $$
BEGIN
    RAISE NOTICE 'Audit logging triggers migration completed successfully';
    RAISE NOTICE 'Triggers created for: memories, api_keys, data_export_requests, sessions';
    RAISE NOTICE 'Retention policy: 7 years (NIS2/DORA compliant)';
END $$;

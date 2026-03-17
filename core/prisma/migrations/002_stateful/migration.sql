-- ==========================================
-- HIVE-MIND Stateful Memory Manager Migration
-- PostgreSQL 15+ with Apache AGE extension
-- EU Sovereign: LUKS2 encryption, HYOK pattern
-- Compliance: GDPR, NIS2, DORA
-- ==========================================

-- ==========================================
-- MEMORY VERSIONS TABLE
-- Tracks version history for temporal reasoning
-- ==========================================

CREATE TABLE IF NOT EXISTS memory_versions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    
    -- Content tracking
    content_hash VARCHAR(64) NOT NULL,
    version INT NOT NULL DEFAULT 1,
    
    -- State tracking
    is_latest BOOLEAN NOT NULL DEFAULT FALSE,
    reason VARCHAR(50) NOT NULL,  -- Updates, Extends, Derives
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

-- Indexes for version history queries
CREATE INDEX IF NOT EXISTS idx_memory_versions_memory ON memory_versions(memory_id);
CREATE INDEX IF NOT EXISTS idx_memory_versions_is_latest ON memory_versions(is_latest);
CREATE INDEX IF NOT EXISTS idx_memory_versions_created ON memory_versions(created_at);
CREATE INDEX IF NOT EXISTS idx_memory_versions_reason ON memory_versions(reason);
CREATE INDEX IF NOT EXISTS idx_memory_versions_version ON memory_versions(version);

-- ==========================================
-- TRIGGER FUNCTION FOR STATE MUTATION
-- Automatically handles isLatest mutation on Updates relationships
-- ==========================================

CREATE OR REPLACE FUNCTION handle_memory_update_trigger()
RETURNS TRIGGER AS $$
DECLARE
    old_memory_id UUID;
    old_content TEXT;
    old_version INT;
    new_version INT;
BEGIN
    -- Check if this is an Updates relationship
    IF NEW.type = 'Updates' THEN
        -- Get the old memory that this updates (to_id points to the memory being updated)
        SELECT id, content INTO old_memory_id, old_content
        FROM memories
        WHERE id = NEW.to_id;
        
        IF old_memory_id IS NOT NULL THEN
            -- Mark old memory as not latest
            UPDATE memories
            SET is_latest = FALSE,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.to_id;
            
            -- Increment version for old memory
            UPDATE memories
            SET version = COALESCE(version, 0) + 1
            WHERE id = NEW.to_id;
            
            -- Get the new version number
            SELECT COALESCE(MAX(version), 0) + 1 INTO new_version
            FROM memory_versions
            WHERE memory_id = NEW.to_id;
            
            -- Create version record for old memory
            INSERT INTO memory_versions (
                memory_id,
                content_hash,
                is_latest,
                version,
                reason,
                created_at
            )
            VALUES (
                NEW.to_id,
                encode(digest(old_content, 'sha256'), 'hex'),
                FALSE,
                new_version,
                'Updates',
                CURRENT_TIMESTAMP
            );
        END IF;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- TRIGGER FOR UPDATES RELATIONSHIPS
-- Automatically marks old memory as not latest
-- ==========================================

DROP TRIGGER IF EXISTS trigger_memory_update ON relationships;

CREATE TRIGGER trigger_memory_update
AFTER INSERT ON relationships
FOR EACH ROW
WHEN (NEW.type = 'Updates')
EXECUTE FUNCTION handle_memory_update_trigger();

-- ==========================================
-- TRIGGER FUNCTION FOR EXTENDS RELATIONSHIPS
-- Extends relationships do NOT change isLatest
-- Both memories remain as isLatest = TRUE
-- ==========================================

CREATE OR REPLACE FUNCTION handle_memory_extend_trigger()
RETURNS TRIGGER AS $$
BEGIN
    -- For Extends relationships, we don't change isLatest
    -- The new memory extends/clarifies the old one
    -- Both remain as isLatest = TRUE
    
    -- Create version record for tracking
    INSERT INTO memory_versions (
        memory_id,
        content_hash,
        is_latest,
        version,
        reason,
        created_at
    )
    SELECT
        NEW.from_id,
        encode(digest(content, 'sha256'), 'hex'),
        TRUE,
        COALESCE(version, 0) + 1,
        'Extends',
        CURRENT_TIMESTAMP
    FROM memories
    WHERE id = NEW.from_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- TRIGGER FOR EXTENDS RELATIONSHIPS
-- ==========================================

DROP TRIGGER IF EXISTS trigger_memory_extend ON relationships;

CREATE TRIGGER trigger_memory_extend
AFTER INSERT ON relationships
FOR EACH ROW
WHEN (NEW.type = 'Extends')
EXECUTE FUNCTION handle_memory_extend_trigger();

-- ==========================================
-- TRIGGER FUNCTION FOR DERIVES RELATIONSHIPS
-- Derives creates independent memory nodes
-- ==========================================

CREATE OR REPLACE FUNCTION handle_memory_derive_trigger()
RETURNS TRIGGER AS $$
BEGIN
    -- For Derives relationships, the new memory is independent
    -- Both source and derived memories can be isLatest = TRUE
    
    -- Create version record for the derived memory
    INSERT INTO memory_versions (
        memory_id,
        content_hash,
        is_latest,
        version,
        reason,
        created_at
    )
    SELECT
        NEW.from_id,
        encode(digest(content, 'sha256'), 'hex'),
        TRUE,
        COALESCE(version, 0) + 1,
        'Derives',
        CURRENT_TIMESTAMP
    FROM memories
    WHERE id = NEW.from_id;
    
    RETURN NEW;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- ==========================================
-- TRIGGER FOR DERIVES RELATIONSHIPS
-- ==========================================

DROP TRIGGER IF EXISTS trigger_memory_derive ON relationships;

CREATE TRIGGER trigger_memory_derive
AFTER INSERT ON relationships
FOR EACH ROW
WHEN (NEW.type = 'Derives')
EXECUTE FUNCTION handle_memory_derive_trigger();

-- ==========================================
-- HELPER FUNCTIONS
-- ==========================================

-- Function to get all versions of a memory
CREATE OR REPLACE FUNCTION get_memory_versions(p_memory_id UUID)
RETURNS TABLE (
    id UUID,
    content_hash VARCHAR(64),
    version INT,
    is_latest BOOLEAN,
    reason VARCHAR(50),
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        mv.id,
        mv.content_hash,
        mv.version,
        mv.is_latest,
        mv.reason,
        mv.created_at
    FROM memory_versions mv
    WHERE mv.memory_id = p_memory_id
    ORDER BY mv.created_at ASC;
END;
$$ LANGUAGE plpgsql;

-- Function to get latest version of a memory
CREATE OR REPLACE FUNCTION get_latest_memory_version(p_memory_id UUID)
RETURNS TABLE (
    id UUID,
    content_hash VARCHAR(64),
    version INT,
    is_latest BOOLEAN,
    reason VARCHAR(50),
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        mv.id,
        mv.content_hash,
        mv.version,
        mv.is_latest,
        mv.reason,
        mv.created_at
    FROM memory_versions mv
    WHERE mv.memory_id = p_memory_id
      AND mv.is_latest = TRUE
    ORDER BY mv.created_at DESC
    LIMIT 1;
END;
$$ LANGUAGE plpgsql;

-- Function to get version history with content for a memory
CREATE OR REPLACE FUNCTION get_memory_version_history(p_memory_id UUID)
RETURNS TABLE (
    version INT,
    content_hash VARCHAR(64),
    is_latest BOOLEAN,
    reason VARCHAR(50),
    content TEXT,
    created_at TIMESTAMPTZ
) AS $$
BEGIN
    RETURN QUERY
    SELECT 
        mv.version,
        mv.content_hash,
        mv.is_latest,
        mv.reason,
        m.content,
        mv.created_at
    FROM memory_versions mv
    JOIN memories m ON mv.memory_id = m.id
    WHERE mv.memory_id = p_memory_id
    ORDER BY mv.created_at ASC;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- CONFLICT RESOLUTION FUNCTIONS
-- ==========================================

-- Function to detect conflicting memories (same content hash, different IDs)
CREATE OR REPLACE FUNCTION detect_memory_conflicts(p_user_id UUID, p_org_id UUID)
RETURNS TABLE (
    content_hash VARCHAR(64),
    memory_id UUID,
    content TEXT,
    is_latest BOOLEAN,
    created_at TIMESTAMPTZ,
    conflict_group INT
) AS $$
DECLARE
    content_hash VARCHAR(64);
    conflict_counter INT := 0;
    prev_hash VARCHAR(64);
BEGIN
    FOR content_hash, memory_id, content, is_latest, created_at IN
        SELECT 
            encode(digest(m.content, 'sha256'), 'hex') as content_hash,
            m.id as memory_id,
            m.content,
            m.is_latest,
            m.created_at
        FROM memories m
        WHERE m.user_id = p_user_id
          AND (p_org_id IS NULL OR m.org_id = p_org_id)
          AND m.deleted_at IS NULL
        ORDER BY content_hash, m.created_at
    LOOP
        IF content_hash != prev_hash THEN
            conflict_counter := conflict_counter + 1;
        END IF;
        
        prev_hash := content_hash;
        
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- Function to resolve conflicts by keeping the latest
CREATE OR REPLACE FUNCTION resolve_conflicts_latest(p_user_id UUID, p_org_id UUID)
RETURNS TABLE (
    keep_id UUID,
    discard_ids UUID[],
    conflict_hash VARCHAR(64),
    resolved_at TIMESTAMPTZ
) AS $$
DECLARE
    conflict RECORD;
    keep_id UUID;
    discard_ids UUID[];
    conflict_hash VARCHAR(64);
BEGIN
    -- Find all memories grouped by content hash
    FOR conflict_hash IN
        SELECT encode(digest(content, 'sha256'), 'hex')
        FROM memories
        WHERE user_id = p_user_id
          AND (p_org_id IS NULL OR org_id = p_org_id)
          AND deleted_at IS NULL
        GROUP BY encode(digest(content, 'sha256'), 'hex')
        HAVING COUNT(*) > 1
    LOOP
        -- Get all memories with this hash, ordered by created_at desc
        discard_ids := ARRAY[]::UUID[];
        keep_id := NULL;
        
        FOR conflict IN
            SELECT id, content, is_latest, created_at
            FROM memories
            WHERE user_id = p_user_id
              AND (p_org_id IS NULL OR org_id = p_org_id)
              AND deleted_at IS NULL
              AND encode(digest(content, 'sha256'), 'hex') = conflict_hash
            ORDER BY created_at DESC
        LOOP
            IF keep_id IS NULL THEN
                keep_id := conflict.id;
            ELSE
                discard_ids := array_append(discard_ids, conflict.id);
                
                -- Mark as not latest
                UPDATE memories
                SET is_latest = FALSE,
                    updated_at = CURRENT_TIMESTAMP
                WHERE id = conflict.id;
                
                -- Create version record for discarded memory
                INSERT INTO memory_versions (
                    memory_id,
                    content_hash,
                    is_latest,
                    version,
                    reason,
                    created_at
                )
                VALUES (
                    conflict.id,
                    conflict_hash,
                    FALSE,
                    COALESCE((SELECT MAX(version) FROM memory_versions WHERE memory_id = conflict.id), 0) + 1,
                    'ConflictResolution',
                    CURRENT_TIMESTAMP
                );
            END IF;
        END LOOP;
        
        RETURN NEXT;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- ==========================================
-- VIEW FOR ACTIVE MEMORIES (Latest Only)
-- ==========================================

CREATE OR REPLACE VIEW active_memories_stateful AS
SELECT
    m.*,
    u.email as user_email,
    o.name as org_name,
    o.data_residency_region,
    (SELECT COUNT(*) FROM memory_versions mv WHERE mv.memory_id = m.id) as version_count,
    (SELECT MAX(mv.version) FROM memory_versions mv WHERE mv.memory_id = m.id) as max_version
FROM memories m
JOIN users u ON m.user_id = u.id
LEFT JOIN organizations o ON m.org_id = o.id
WHERE m.is_latest = TRUE
  AND m.deleted_at IS NULL
  AND (m.retention_until IS NULL OR m.retention_until > CURRENT_TIMESTAMP);

-- ==========================================
-- VIEW FOR VERSION HISTORY
-- ==========================================

CREATE OR REPLACE VIEW memory_version_history_view AS
SELECT
    mv.id as version_id,
    mv.memory_id,
    m.content as current_content,
    mv.content_hash,
    mv.version,
    mv.is_latest,
    mv.reason,
    mv.created_at as version_created_at,
    m.created_at as memory_created_at,
    m.updated_at as memory_updated_at
FROM memory_versions mv
JOIN memories m ON mv.memory_id = m.id
ORDER BY mv.memory_id, mv.created_at;

-- ==========================================
-- COMPLIANCE: AUDIT TRIGGER FOR VERSION CHANGES
-- ==========================================

CREATE OR REPLACE FUNCTION audit_version_changes()
RETURNS TRIGGER AS $$
DECLARE
    old_val JSONB;
    new_val JSONB;
BEGIN
    IF TG_OP = 'INSERT' THEN
        new_val := to_jsonb(NEW);
        INSERT INTO audit_logs (
            event_type,
            event_category,
            resource_type,
            resource_id,
            action,
            new_value,
            created_at
        ) VALUES (
            'memory_version_created',
            'data_modification',
            'memory_versions',
            NEW.memory_id,
            'create',
            new_val,
            CURRENT_TIMESTAMP
        );
        RETURN NEW;
    ELSIF TG_OP = 'UPDATE' THEN
        old_val := to_jsonb(OLD);
        new_val := to_jsonb(NEW);
        INSERT INTO audit_logs (
            event_type,
            event_category,
            resource_type,
            resource_id,
            action,
            old_value,
            new_value,
            created_at
        ) VALUES (
            'memory_version_updated',
            'data_modification',
            'memory_versions',
            NEW.memory_id,
            'update',
            old_val,
            new_val,
            CURRENT_TIMESTAMP
        );
        RETURN NEW;
    END IF;
    RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_memory_versions_changes
    AFTER INSERT OR UPDATE ON memory_versions
    FOR EACH ROW EXECUTE FUNCTION audit_version_changes();

-- ==========================================
-- COMPLIANCE: AUDIT TRIGGER FOR MEMORY IS_LATEST CHANGES
-- ==========================================

CREATE OR REPLACE FUNCTION audit_is_latest_changes()
RETURNS TRIGGER AS $$
DECLARE
    old_val JSONB;
    new_val JSONB;
BEGIN
    IF TG_OP = 'UPDATE' AND OLD.is_latest IS DISTINCT FROM NEW.is_latest THEN
        old_val := jsonb_build_object('is_latest', OLD.is_latest);
        new_val := jsonb_build_object('is_latest', NEW.is_latest);
        INSERT INTO audit_logs (
            event_type,
            event_category,
            resource_type,
            resource_id,
            action,
            old_value,
            new_value,
            created_at
        ) VALUES (
            'memory_is_latest_changed',
            'data_modification',
            'memories',
            NEW.id,
            'update',
            old_val,
            new_val,
            CURRENT_TIMESTAMP
        );
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER audit_memories_is_latest_changes
    AFTER UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION audit_is_latest_changes();

-- ==========================================
-- MIGRATION COMPLETE
-- ==========================================

COMMENT ON TABLE memory_versions IS 'Tracks version history for temporal reasoning and conflict resolution';
COMMENT ON TABLE relationships IS 'Graph edges between memories (Updates, Extends, Derives)';
COMMENT ON COLUMN relationships.type IS 'Relationship type: Updates (changes meaning), Extends (clarifies), Derives (inference)';

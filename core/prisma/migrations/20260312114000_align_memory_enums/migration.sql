DO $$
BEGIN
  CREATE TYPE "MemoryType" AS ENUM (
    'fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "RelationshipType" AS ENUM (
    'Updates', 'Extends', 'Derives'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DO $$
BEGIN
  CREATE TYPE "VisibilityScope" AS ENUM (
    'private', 'organization', 'public'
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

DROP VIEW IF EXISTS active_memories_stateful;
DROP VIEW IF EXISTS memory_version_history_view;
DROP TRIGGER IF EXISTS trigger_memory_update ON relationships;
DROP TRIGGER IF EXISTS trigger_memory_extend ON relationships;
DROP TRIGGER IF EXISTS trigger_memory_derive ON relationships;

ALTER TABLE memories
  ALTER COLUMN memory_type DROP DEFAULT;

ALTER TABLE memories
  ALTER COLUMN visibility DROP DEFAULT;

ALTER TABLE memories
  ALTER COLUMN memory_type TYPE "MemoryType"
  USING memory_type::text::"MemoryType";

ALTER TABLE memories
  ALTER COLUMN visibility TYPE "VisibilityScope"
  USING visibility::text::"VisibilityScope";

ALTER TABLE relationships
  ALTER COLUMN type TYPE "RelationshipType"
  USING type::text::"RelationshipType";

ALTER TABLE memories
  ALTER COLUMN memory_type SET DEFAULT 'fact'::"MemoryType";

ALTER TABLE memories
  ALTER COLUMN visibility SET DEFAULT 'private'::"VisibilityScope";

CREATE TRIGGER trigger_memory_update
AFTER INSERT ON relationships
FOR EACH ROW
WHEN (NEW.type = 'Updates')
EXECUTE FUNCTION handle_memory_update_trigger();

CREATE TRIGGER trigger_memory_extend
AFTER INSERT ON relationships
FOR EACH ROW
WHEN (NEW.type = 'Extends')
EXECUTE FUNCTION handle_memory_extend_trigger();

CREATE TRIGGER trigger_memory_derive
AFTER INSERT ON relationships
FOR EACH ROW
WHEN (NEW.type = 'Derives')
EXECUTE FUNCTION handle_memory_derive_trigger();

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

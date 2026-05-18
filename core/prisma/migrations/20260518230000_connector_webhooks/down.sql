-- ============================================================
-- Rollback: connector_webhooks
-- ============================================================

BEGIN;

-- Drop GIN index on nango_connections (if table and index exist)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_name = 'nango_connections'
  ) THEN
    DROP INDEX IF EXISTS "nango_connections_metadata_gin_idx";
  END IF;
END$$;

-- Drop webhook_events before subscriptions (FK dependency)
DROP TABLE IF EXISTS "webhook_events";
DROP TABLE IF EXISTS "webhook_subscriptions";

COMMIT;

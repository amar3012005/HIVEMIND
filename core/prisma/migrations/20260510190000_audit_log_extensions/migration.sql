-- ============================================================
-- Migration: AuditLog extensions for SOC2 / GDPR readiness
--
-- Adds: actor_type, actor_api_key_id, metadata (jsonb diff),
--       request_id, retention_until
-- Refines existing column semantics without breaking back-compat.
-- ============================================================

ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "actor_type" VARCHAR(20) DEFAULT 'user';
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "actor_api_key_id" UUID;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "metadata" JSONB DEFAULT '{}'::jsonb;
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "request_id" VARCHAR(64);
ALTER TABLE "audit_logs" ADD COLUMN IF NOT EXISTS "retention_until" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "audit_logs_actor_type_idx" ON "audit_logs"("actor_type");
CREATE INDEX IF NOT EXISTS "audit_logs_org_created_idx" ON "audit_logs"("organization_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_user_created_idx" ON "audit_logs"("user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "audit_logs_request_id_idx" ON "audit_logs"("request_id");

-- Optional FK if api_keys table exists (don't fail if not present yet)
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'api_keys') THEN
    BEGIN
      ALTER TABLE "audit_logs"
        ADD CONSTRAINT "audit_logs_actor_api_key_id_fkey"
        FOREIGN KEY ("actor_api_key_id") REFERENCES "api_keys"("id")
        ON DELETE SET NULL ON UPDATE NO ACTION;
    EXCEPTION WHEN duplicate_object THEN NULL;
    END;
  END IF;
END$$;

-- Compliance-friendly: prevent UPDATE and DELETE on audit_logs at DB level
-- (admin can read but not tamper). Tools like pg_dump still work for backup.
CREATE OR REPLACE RULE audit_logs_no_update AS
  ON UPDATE TO "audit_logs" DO INSTEAD NOTHING;

-- DELETE allowed only via retention cron (uses set_config) — block ad-hoc.
CREATE OR REPLACE FUNCTION audit_logs_block_delete() RETURNS trigger AS $$
BEGIN
  IF current_setting('app.audit_retention_purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'audit_logs delete is not permitted (use retention cron)';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS audit_logs_block_delete_trg ON "audit_logs";
CREATE TRIGGER audit_logs_block_delete_trg
  BEFORE DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_delete();

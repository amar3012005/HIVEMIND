-- Audit identifiers are historical evidence, not live relational ownership.
-- SET NULL/CASCADE foreign keys mutate history and conflict with append-only guarantees.
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_user_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_organization_id_fkey";
ALTER TABLE "audit_logs" DROP CONSTRAINT IF EXISTS "audit_logs_resource_id_fkey";

CREATE OR REPLACE FUNCTION "append_only_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden - append-only audit trail', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP RULE IF EXISTS "audit_logs_no_update" ON "audit_logs";
DROP TRIGGER IF EXISTS "audit_logs_block_delete_trg" ON "audit_logs";
DROP TRIGGER IF EXISTS "audit_logs_append_only" ON "audit_logs";
CREATE TRIGGER "audit_logs_append_only"
  BEFORE UPDATE OR DELETE ON "audit_logs"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();

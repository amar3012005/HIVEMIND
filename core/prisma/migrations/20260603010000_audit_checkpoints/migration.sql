-- Defense-in-depth for the SLH-DSA audit chain (FIPS 205).
--
-- (L1) Append-only guard: a BEFORE UPDATE OR DELETE trigger that always raises.
-- Unlike REVOKE (which the table owner bypasses), a trigger fires for every
-- role including the owner, so a compromised app role cannot delete/mutate the
-- signed audit trail. Only a superuser disabling the trigger can bypass it.
--
-- (H5) Signed tail checkpoint: the hash chain + genesis anchor detect mutation,
-- reorder, and head truncation — but NOT deletion of the most-recent entries.
-- Periodic signed checkpoints (org_id, max_seq, head_entry_hash, row_count)
-- anchor the tail so audit-verify can detect truncation below the last
-- checkpoint.

CREATE TABLE IF NOT EXISTS "audit_checkpoints" (
  "id" BIGSERIAL PRIMARY KEY,
  "org_id" UUID,
  "max_seq" BIGINT NOT NULL,
  "head_entry_hash" VARCHAR(64) NOT NULL,
  "row_count" BIGINT NOT NULL DEFAULT 0,
  "alg" VARCHAR(40) NOT NULL DEFAULT 'SLH-DSA-SHA2-128s',
  "signature" TEXT NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "audit_checkpoints_org_idx" ON "audit_checkpoints"("org_id", "id" DESC);

-- Append-only enforcement on the signature trail + the checkpoints themselves.
CREATE OR REPLACE FUNCTION "append_only_guard"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% on % is forbidden — append-only audit trail', TG_OP, TG_TABLE_NAME;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS "audit_signatures_append_only" ON "audit_signatures";
CREATE TRIGGER "audit_signatures_append_only"
  BEFORE UPDATE OR DELETE ON "audit_signatures"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();

DROP TRIGGER IF EXISTS "audit_checkpoints_append_only" ON "audit_checkpoints";
CREATE TRIGGER "audit_checkpoints_append_only"
  BEFORE UPDATE OR DELETE ON "audit_checkpoints"
  FOR EACH ROW EXECUTE FUNCTION "append_only_guard"();

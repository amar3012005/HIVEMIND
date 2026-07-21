-- Canonical Memory Engine V5 — Phase 1: canonical source + claim identity.
-- Additive + backward-compatible (all columns nullable, no data rewrite).
-- Idempotent (IF NOT EXISTS) so it is safe on the baselined production DB.
-- Canonical tables live in the "hivemind" schema.

-- KnowledgeDocument: canonical source identity
ALTER TABLE "hivemind"."knowledge_documents" ADD COLUMN IF NOT EXISTS "canonical_ingest_key" VARCHAR(128);
ALTER TABLE "hivemind"."knowledge_documents" ADD COLUMN IF NOT EXISTS "source_external_id"   VARCHAR(500);
ALTER TABLE "hivemind"."knowledge_documents" ADD COLUMN IF NOT EXISTS "source_version"        VARCHAR(100);
ALTER TABLE "hivemind"."knowledge_documents" ADD COLUMN IF NOT EXISTS "content_hash"           VARCHAR(128);
ALTER TABLE "hivemind"."knowledge_documents" ADD COLUMN IF NOT EXISTS "processing_version"     INTEGER;

-- Memory: structured claim identity
ALTER TABLE "hivemind"."memories" ADD COLUMN IF NOT EXISTS "claim_key"             VARCHAR(128);
ALTER TABLE "hivemind"."memories" ADD COLUMN IF NOT EXISTS "claim_subject"         VARCHAR(500);
ALTER TABLE "hivemind"."memories" ADD COLUMN IF NOT EXISTS "claim_predicate"       VARCHAR(500);
ALTER TABLE "hivemind"."memories" ADD COLUMN IF NOT EXISTS "claim_qualifiers"      JSONB;
ALTER TABLE "hivemind"."memories" ADD COLUMN IF NOT EXISTS "extraction_confidence" REAL;

-- Indexes
CREATE INDEX IF NOT EXISTS "memories_org_claim_latest_idx"
  ON "hivemind"."memories" ("org_id", "claim_key", "is_latest", "deleted_at");

-- Unique per-org canonical ingest key (partial: only rows that set it, so legacy
-- NULL rows are unaffected and multiple NULLs never collide).
CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_org_canonical_key_uq"
  ON "hivemind"."knowledge_documents" ("org_id", "canonical_ingest_key")
  WHERE "canonical_ingest_key" IS NOT NULL;

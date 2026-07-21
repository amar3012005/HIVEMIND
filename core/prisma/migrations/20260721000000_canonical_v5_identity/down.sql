-- Rollback for canonical_v5_identity (manual; Prisma has no auto-down).
DROP INDEX IF EXISTS "hivemind"."knowledge_documents_org_canonical_key_uq";
DROP INDEX IF EXISTS "hivemind"."memories_org_claim_latest_idx";
ALTER TABLE "hivemind"."memories" DROP COLUMN IF EXISTS "extraction_confidence", DROP COLUMN IF EXISTS "claim_qualifiers", DROP COLUMN IF EXISTS "claim_predicate", DROP COLUMN IF EXISTS "claim_subject", DROP COLUMN IF EXISTS "claim_key";
ALTER TABLE "hivemind"."knowledge_documents" DROP COLUMN IF EXISTS "processing_version", DROP COLUMN IF EXISTS "content_hash", DROP COLUMN IF EXISTS "source_version", DROP COLUMN IF EXISTS "source_external_id", DROP COLUMN IF EXISTS "canonical_ingest_key";

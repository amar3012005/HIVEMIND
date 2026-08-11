DROP INDEX IF EXISTS "knowledge_ingest_jobs_org_id_ingest_mode_status_idx";
DROP INDEX IF EXISTS "knowledge_documents_org_id_ingest_mode_idx";

ALTER TABLE "knowledge_ingest_jobs"
  DROP CONSTRAINT IF EXISTS "knowledge_ingest_jobs_evidence_only_reason_check",
  DROP CONSTRAINT IF EXISTS "knowledge_ingest_jobs_ingest_mode_check",
  DROP COLUMN IF EXISTS "evidence_only_reason",
  DROP COLUMN IF EXISTS "ingest_mode";

ALTER TABLE "knowledge_documents"
  DROP CONSTRAINT IF EXISTS "knowledge_documents_ingest_mode_check",
  DROP COLUMN IF EXISTS "ingest_mode";

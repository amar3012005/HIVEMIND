ALTER TABLE "knowledge_documents"
  ADD COLUMN IF NOT EXISTS "ingest_mode" VARCHAR(16) NOT NULL DEFAULT 'both';

ALTER TABLE "knowledge_ingest_jobs"
  ADD COLUMN IF NOT EXISTS "ingest_mode" VARCHAR(16) NOT NULL DEFAULT 'both',
  ADD COLUMN IF NOT EXISTS "evidence_only_reason" VARCHAR(32);

ALTER TABLE "knowledge_documents"
  ADD CONSTRAINT "knowledge_documents_ingest_mode_check"
  CHECK ("ingest_mode" IN ('both', 'evidence'));

ALTER TABLE "knowledge_ingest_jobs"
  ADD CONSTRAINT "knowledge_ingest_jobs_ingest_mode_check"
  CHECK ("ingest_mode" IN ('both', 'evidence'));

ALTER TABLE "knowledge_ingest_jobs"
  ADD CONSTRAINT "knowledge_ingest_jobs_evidence_only_reason_check"
  CHECK ("evidence_only_reason" IS NULL OR "evidence_only_reason" IN
    ('user_selected', 'promotion_failed', 'extraction_yield_zero'));

CREATE INDEX IF NOT EXISTS "knowledge_documents_org_id_ingest_mode_idx"
  ON "knowledge_documents"("org_id", "ingest_mode");

CREATE INDEX IF NOT EXISTS "knowledge_ingest_jobs_org_id_ingest_mode_status_idx"
  ON "knowledge_ingest_jobs"("org_id", "ingest_mode", "status");

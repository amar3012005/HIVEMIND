-- Production uses DATABASE_URL schema=hivemind. The preceding additive
-- migration was applied with an unqualified CREATE TABLE and PostgreSQL placed
-- the empty table in public. Recreate it in the application schema expected by
-- Prisma. No data migration is required: the failed canary never acquired or
-- wrote a lease.
DROP TABLE IF EXISTS public."knowledge_ingest_leases";

CREATE TABLE IF NOT EXISTS hivemind."knowledge_ingest_leases" (
  "lease_key" VARCHAR(80) PRIMARY KEY,
  "job_id" UUID NOT NULL,
  "processing_version" INTEGER NOT NULL,
  "lease_token" UUID NOT NULL,
  "lease_until" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS "knowledge_ingest_leases_lease_until_idx"
  ON hivemind."knowledge_ingest_leases" ("lease_until");
CREATE INDEX IF NOT EXISTS "knowledge_ingest_leases_job_version_idx"
  ON hivemind."knowledge_ingest_leases" ("job_id", "processing_version");

CREATE TABLE IF NOT EXISTS "knowledge_ingest_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "scope_type" varchar(24) NOT NULL,
  "scope_id" uuid,
  "scope_key" varchar(160) NOT NULL,
  "storage_mode" varchar(32) NOT NULL,
  "filename" varchar(500) NOT NULL,
  "content_type" varchar(160),
  "media_kind" varchar(24) NOT NULL,
  "checksum" varchar(64) NOT NULL,
  "status" varchar(32) NOT NULL DEFAULT 'queued',
  "stage" varchar(48) NOT NULL DEFAULT 'accepted',
  "progress" integer NOT NULL DEFAULT 0 CHECK ("progress" BETWEEN 0 AND 100),
  "processing_version" integer NOT NULL DEFAULT 1,
  "attempt" integer NOT NULL DEFAULT 0,
  "queue_job_id" varchar(160),
  "document_id" uuid,
  "memory_ids" uuid[] NOT NULL DEFAULT '{}',
  "page_count" integer,
  "segment_count" integer,
  "candidate_count" integer,
  "promoted_count" integer,
  "usage_settled_at" timestamptz,
  "error_code" varchar(80),
  "error_message" text,
  "metadata" jsonb NOT NULL DEFAULT '{}',
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz
);
CREATE INDEX IF NOT EXISTS "knowledge_ingest_jobs_org_user_created_idx" ON "knowledge_ingest_jobs" ("org_id", "user_id", "created_at" DESC);
CREATE INDEX IF NOT EXISTS "knowledge_ingest_jobs_org_status_updated_idx" ON "knowledge_ingest_jobs" ("org_id", "status", "updated_at");
CREATE INDEX IF NOT EXISTS "knowledge_ingest_jobs_org_scope_checksum_idx" ON "knowledge_ingest_jobs" ("org_id", "scope_key", "checksum");
CREATE INDEX IF NOT EXISTS "knowledge_ingest_jobs_queue_job_idx" ON "knowledge_ingest_jobs" ("queue_job_id");

CREATE TABLE IF NOT EXISTS "knowledge_usage_settlements" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" uuid NOT NULL,
  "user_id" uuid NOT NULL,
  "job_id" uuid NOT NULL,
  "metric" varchar(32) NOT NULL,
  "amount" bigint NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "knowledge_usage_settlements_job_metric_key" UNIQUE ("job_id", "metric")
);
CREATE INDEX IF NOT EXISTS "knowledge_usage_settlements_org_user_created_idx" ON "knowledge_usage_settlements" ("org_id", "user_id", "created_at" DESC);

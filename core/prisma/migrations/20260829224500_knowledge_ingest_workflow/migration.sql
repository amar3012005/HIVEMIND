ALTER TABLE knowledge_ingest_jobs
  ADD COLUMN IF NOT EXISTS orchestration_mode VARCHAR(32) NOT NULL DEFAULT 'bullmq',
  ADD COLUMN IF NOT EXISTS workflow_instance_id VARCHAR(160),
  ADD COLUMN IF NOT EXISTS pipeline_version INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS source_object_key VARCHAR(700),
  ADD COLUMN IF NOT EXISTS source_object_etag VARCHAR(160);

CREATE INDEX IF NOT EXISTS knowledge_ingest_jobs_workflow_instance_id_idx
  ON knowledge_ingest_jobs (workflow_instance_id);

CREATE TABLE IF NOT EXISTS knowledge_ingest_steps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id UUID NOT NULL REFERENCES knowledge_ingest_jobs(id) ON DELETE CASCADE,
  processing_version INTEGER NOT NULL,
  stage_key VARCHAR(64) NOT NULL,
  shard_key VARCHAR(160) NOT NULL DEFAULT 'root',
  status VARCHAR(24) NOT NULL DEFAULT 'pending',
  attempt INTEGER NOT NULL DEFAULT 0,
  input_digest VARCHAR(128),
  output_refs JSONB NOT NULL DEFAULT '{}'::jsonb,
  coverage JSONB NOT NULL DEFAULT '{}'::jsonb,
  lease_until TIMESTAMPTZ,
  error_code VARCHAR(80),
  error_message TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS knowledge_ingest_steps_identity_key
  ON knowledge_ingest_steps (job_id, processing_version, stage_key, shard_key);
CREATE INDEX IF NOT EXISTS knowledge_ingest_steps_job_status_idx
  ON knowledge_ingest_steps (job_id, processing_version, status);
CREATE INDEX IF NOT EXISTS knowledge_ingest_steps_lease_idx
  ON knowledge_ingest_steps (status, lease_until);

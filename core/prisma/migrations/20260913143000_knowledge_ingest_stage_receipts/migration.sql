-- Durable, content-free local stage accounting for Workflow/BullMQ handoff.
-- All customer content remains in the authoritative document/memory tables;
-- these columns contain policy, counters and opaque references only.
ALTER TABLE hivemind.knowledge_ingest_steps
  ADD COLUMN IF NOT EXISTS mode VARCHAR(16),
  ADD COLUMN IF NOT EXISTS stage_policy JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS model_calls INTEGER,
  ADD COLUMN IF NOT EXISTS resource_counts JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE hivemind.knowledge_ingest_jobs
  ADD COLUMN IF NOT EXISTS fallback_from_version INTEGER,
  ADD COLUMN IF NOT EXISTS fallback_reason VARCHAR(80);

ALTER TABLE hivemind.knowledge_ingest_steps
  DROP CONSTRAINT IF EXISTS knowledge_ingest_steps_mode_check;
ALTER TABLE hivemind.knowledge_ingest_steps
  ADD CONSTRAINT knowledge_ingest_steps_mode_check
  CHECK (mode IS NULL OR mode IN ('evidence', 'both'));

ALTER TABLE hivemind.knowledge_ingest_steps
  DROP CONSTRAINT IF EXISTS knowledge_ingest_steps_model_calls_check;
ALTER TABLE hivemind.knowledge_ingest_steps
  ADD CONSTRAINT knowledge_ingest_steps_model_calls_check
  CHECK (model_calls IS NULL OR model_calls >= 0);

CREATE INDEX IF NOT EXISTS knowledge_ingest_steps_job_version_mode_status_idx
  ON hivemind.knowledge_ingest_steps(job_id, processing_version, mode, status);

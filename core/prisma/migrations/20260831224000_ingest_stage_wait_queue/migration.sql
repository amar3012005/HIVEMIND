-- Prepared, indexed wait rows let the stage scheduler claim one oldest job
-- without ranking the whole upload table in an interactive transaction.
CREATE INDEX IF NOT EXISTS "knowledge_ingest_steps_stage_key_status_created_at_idx"
  ON "knowledge_ingest_steps" ("stage_key", "status", "created_at");

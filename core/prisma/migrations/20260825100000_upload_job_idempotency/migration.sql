-- A live upload is unique per tenant, destination scope, and source bytes.
-- Terminal failures are excluded so a later retry can reuse/recover them.
CREATE UNIQUE INDEX IF NOT EXISTS knowledge_ingest_jobs_active_source_key
  ON knowledge_ingest_jobs (org_id, scope_key, checksum)
  WHERE status IN ('queued', 'processing', 'ready');

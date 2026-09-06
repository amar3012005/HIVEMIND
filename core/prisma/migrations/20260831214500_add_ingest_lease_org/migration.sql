-- The original rollout created this table out of band. A clean schema must
-- establish the v1 lease shape before this additive org-scope migration.
CREATE TABLE IF NOT EXISTS hivemind.knowledge_ingest_leases (
  lease_key VARCHAR(80) PRIMARY KEY,
  job_id UUID NOT NULL,
  processing_version INTEGER NOT NULL,
  lease_token UUID NOT NULL,
  lease_until TIMESTAMPTZ(6) NOT NULL,
  created_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS knowledge_ingest_leases_lease_until_idx
  ON hivemind.knowledge_ingest_leases (lease_until);
CREATE INDEX IF NOT EXISTS knowledge_ingest_leases_job_version_idx
  ON hivemind.knowledge_ingest_leases (job_id, processing_version);

ALTER TABLE hivemind.knowledge_ingest_leases
  ADD COLUMN IF NOT EXISTS org_id UUID;

-- The v1 scheduler used a singleton key. It cannot participate in the v2 slot
-- pool and is safe to remove because the rollout is disabled before migration.
DELETE FROM hivemind.knowledge_ingest_leases
WHERE lease_key = 'knowledge-ingest-production';

UPDATE hivemind.knowledge_ingest_leases AS lease
SET org_id = job.org_id
FROM hivemind.knowledge_ingest_jobs AS job
WHERE lease.job_id = job.id
  AND lease.org_id IS NULL;

DELETE FROM hivemind.knowledge_ingest_leases WHERE org_id IS NULL;

ALTER TABLE hivemind.knowledge_ingest_leases
  ALTER COLUMN org_id SET NOT NULL;

CREATE INDEX IF NOT EXISTS knowledge_ingest_leases_org_id_lease_until_idx
  ON hivemind.knowledge_ingest_leases(org_id, lease_until);

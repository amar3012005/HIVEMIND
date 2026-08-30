-- Fence late results from an expired stage lease.  A reclaimed worker receives
-- a new token; the previous worker can no longer mark that receipt successful.
ALTER TABLE knowledge_ingest_steps
  ADD COLUMN IF NOT EXISTS lease_token UUID;


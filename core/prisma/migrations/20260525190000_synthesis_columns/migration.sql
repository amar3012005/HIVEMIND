-- Phase 1 Cognition Loop: synthesis quality columns
-- Adds four columns to the memories table for tracking LLM synthesis provenance,
-- confidence, and cluster identity. All columns are nullable / have defaults so
-- existing rows are unaffected and the migration is fully backward-compatible.

ALTER TABLE hivemind.memories ADD COLUMN IF NOT EXISTS synthesis_confidence FLOAT;
ALTER TABLE hivemind.memories ADD COLUMN IF NOT EXISTS synthesis_evidence_ids UUID[] DEFAULT '{}';
ALTER TABLE hivemind.memories ADD COLUMN IF NOT EXISTS synthesis_cluster_hash TEXT;
ALTER TABLE hivemind.memories ADD COLUMN IF NOT EXISTS synthesis_revision INT NOT NULL DEFAULT 1;

-- Partial index on synthesis_cluster_hash — only synthesis outputs have this set.
-- Used by the 6-hour cooldown check (fast lookup by cluster hash) and the
-- recall-router boost path (filter canonical-fact / synthesis-bridge by source type).
CREATE INDEX IF NOT EXISTS memories_synthesis_cluster_hash_idx
  ON hivemind.memories (synthesis_cluster_hash)
  WHERE synthesis_cluster_hash IS NOT NULL;

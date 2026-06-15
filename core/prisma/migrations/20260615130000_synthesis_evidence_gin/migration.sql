-- H8: GIN index on memories.synthesis_evidence_ids (UUID[]).
-- The duplicate-canonical guard runs `synthesisEvidenceIds @> / && [...]`
-- (`{ hasSome: evidenceIds }`) once per new synthesis. Without a GIN index
-- Postgres post-filters the array overlap at the executor level over every
-- latest synthesis row. IF NOT EXISTS keeps this idempotent — the index is
-- also created out-of-band with CREATE INDEX CONCURRENTLY at deploy time.
CREATE INDEX IF NOT EXISTS memories_synthesis_evidence_ids_gin
  ON hivemind.memories USING GIN (synthesis_evidence_ids);

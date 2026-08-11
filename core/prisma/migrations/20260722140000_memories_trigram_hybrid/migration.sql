-- Hybrid lexical recall (rosemary): pg_trgm trigram index on memories so a
-- lexical lane can retrieve concatenated/fuzzy product names ("solvis tim" ↔
-- "SolvisTim") that FTS prefix-matching (tim:* ) misses, and rare distinctive
-- tokens. Additive: extension + GIN index, no data/DDL change to existing cols.
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS idx_memories_trgm_title_content
  ON hivemind.memories USING gin ((coalesce(title,'') || ' ' || coalesce(content,'')) gin_trgm_ops);

-- Recall scale (millions-of-docs): the FTS GIN index was orphaned on the EMPTY
-- public.memories; the real hivemind.memories seq-scanned FTS on every recall.
-- Add index-accelerated FTS on the REAL tables, expression-matched to the query
-- (title||' '||content, 'simple' config — no English stemmer mangling German).
-- Additive (indexes only). At true millions, recreate these CONCURRENTLY.

-- Drop the orphaned/dead index (was on public.memories, 0 rows).
DROP INDEX IF EXISTS public.memories_content_fts_idx;

-- Memories: FTS GIN matching the searchMemories query expression exactly.
CREATE INDEX IF NOT EXISTS memories_fts_simple_idx
  ON hivemind.memories USING gin (to_tsvector('simple', coalesce(title,'') || ' ' || coalesce(content,'')));

-- Knowledge segments (evidence): FTS + trigram GIN so the evidence lexical lane
-- is index-accelerated too (it had neither).
CREATE INDEX IF NOT EXISTS knowledge_segments_fts_simple_idx
  ON hivemind.knowledge_segments USING gin (to_tsvector('simple', coalesce(content,'')));
CREATE INDEX IF NOT EXISTS knowledge_segments_trgm_idx
  ON hivemind.knowledge_segments USING gin (coalesce(content,'') gin_trgm_ops);

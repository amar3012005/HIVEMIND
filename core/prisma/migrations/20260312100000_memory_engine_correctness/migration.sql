CREATE TABLE IF NOT EXISTS memory_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  version INTEGER NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  is_latest BOOLEAN NOT NULL DEFAULT TRUE,
  reason TEXT NOT NULL,
  related_memory_id UUID NULL REFERENCES memories(id) ON DELETE SET NULL,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_memory_versions_memory_created
  ON memory_versions(memory_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_memory_versions_memory_latest
  ON memory_versions(memory_id, is_latest);

CREATE TABLE IF NOT EXISTS source_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL UNIQUE REFERENCES memories(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL,
  source_id TEXT NULL,
  source_platform TEXT NULL,
  source_url TEXT NULL,
  thread_id TEXT NULL,
  parent_message_id TEXT NULL,
  ingested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_source_metadata_type_id
  ON source_metadata(source_type, source_id);
CREATE INDEX IF NOT EXISTS idx_source_metadata_platform
  ON source_metadata(source_platform);

CREATE TABLE IF NOT EXISTS code_memory_metadata (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  memory_id UUID NOT NULL UNIQUE REFERENCES memories(id) ON DELETE CASCADE,
  filepath TEXT NOT NULL,
  language TEXT NOT NULL,
  entity_type TEXT NULL,
  entity_name TEXT NULL,
  start_line INTEGER NULL,
  end_line INTEGER NULL,
  scope_chain TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  signatures TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  imports TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  dependencies TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  nws_count INTEGER NOT NULL DEFAULT 0,
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_code_memory_metadata_filepath
  ON code_memory_metadata(filepath);
CREATE INDEX IF NOT EXISTS idx_code_memory_metadata_language
  ON code_memory_metadata(language);

CREATE TABLE IF NOT EXISTS derivation_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  target_memory_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
  confidence DOUBLE PRECISION NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ NULL
);

CREATE INDEX IF NOT EXISTS idx_derivation_jobs_status_created
  ON derivation_jobs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_derivation_jobs_source
  ON derivation_jobs(source_memory_id);
CREATE INDEX IF NOT EXISTS idx_derivation_jobs_target
  ON derivation_jobs(target_memory_id);

CREATE OR REPLACE FUNCTION acquire_memory_user_lock(p_user_id UUID)
RETURNS VOID AS $$
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended(COALESCE(p_user_id::text, 'global'), 0));
END;
$$ LANGUAGE plpgsql;

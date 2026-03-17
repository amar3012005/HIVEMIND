ALTER TABLE memory_versions
  ADD COLUMN IF NOT EXISTS related_memory_id UUID NULL REFERENCES memories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_memory_versions_related_memory
  ON memory_versions(related_memory_id);

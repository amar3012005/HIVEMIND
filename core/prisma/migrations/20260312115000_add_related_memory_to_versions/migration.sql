ALTER TABLE hivemind.memory_versions
  ADD COLUMN IF NOT EXISTS related_memory_id UUID NULL REFERENCES hivemind.memories(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_memory_versions_related_memory
  ON hivemind.memory_versions(related_memory_id);

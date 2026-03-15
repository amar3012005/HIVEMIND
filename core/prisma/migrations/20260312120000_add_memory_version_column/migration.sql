ALTER TABLE hivemind.memories
  ADD COLUMN IF NOT EXISTS version INTEGER NOT NULL DEFAULT 1;

CREATE INDEX IF NOT EXISTS memories_version_idx
  ON hivemind.memories(version);

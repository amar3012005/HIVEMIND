ALTER TABLE hivemind.memories
  ADD COLUMN IF NOT EXISTS project TEXT;

CREATE INDEX IF NOT EXISTS memories_project_idx
  ON hivemind.memories(project);

CREATE INDEX IF NOT EXISTS memories_org_created_at_idx
  ON hivemind.memories (org_id, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS memories_org_valid_window_idx
  ON hivemind.memories (org_id, valid_from, valid_to)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS hivemind.recall_quality_reconciliation_cursor (
  org_id uuid PRIMARY KEY,
  created_at_cursor timestamptz,
  memory_id_cursor uuid,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS hivemind.recall_sparse_sync (
  memory_id uuid PRIMARY KEY REFERENCES hivemind.memories(id) ON DELETE CASCADE,
  updated_at timestamptz NOT NULL DEFAULT now()
);

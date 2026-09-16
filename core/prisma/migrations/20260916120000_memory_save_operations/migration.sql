CREATE TABLE IF NOT EXISTS hivemind.memory_save_operations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL,
  user_id UUID NOT NULL,
  idempotency_key TEXT NOT NULL,
  operation_id TEXT NOT NULL,
  status TEXT NOT NULL,
  destination_scope TEXT,
  request JSONB NOT NULL DEFAULT '{}'::jsonb,
  receipt JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT memory_save_operations_status_chk
    CHECK (status IN ('prepared', 'approved', 'executing', 'completed', 'cancelled')),
  CONSTRAINT memory_save_operations_org_key UNIQUE (org_id, idempotency_key),
  CONSTRAINT memory_save_operations_org_op UNIQUE (org_id, operation_id)
);

CREATE INDEX IF NOT EXISTS memory_save_operations_org_user_updated_idx
  ON hivemind.memory_save_operations (org_id, user_id, updated_at DESC);

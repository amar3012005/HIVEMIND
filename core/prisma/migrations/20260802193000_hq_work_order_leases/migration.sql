ALTER TABLE hivemind.hyper_work_orders
  ADD COLUMN IF NOT EXISTS lease_owner varchar(160),
  ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz,
  ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;

CREATE INDEX IF NOT EXISTS hyper_work_orders_status_lease_idx
  ON hivemind.hyper_work_orders (status, lease_expires_at);

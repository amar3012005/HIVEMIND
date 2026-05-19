-- Per-connector sync cadence override.
-- NULL = use global scheduler interval (HIVEMIND_SYNC_INTERVAL_MS).
-- Otherwise: connector syncs every N minutes (floor 15, no cap).

ALTER TABLE public.platform_integrations
  ADD COLUMN IF NOT EXISTS sync_interval_minutes INT;

ALTER TABLE public.platform_integrations
  ADD COLUMN IF NOT EXISTS last_scheduler_run_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_pi_scheduler_due
  ON public.platform_integrations(last_scheduler_run_at)
  WHERE is_active = true AND sync_status != 'revoked';

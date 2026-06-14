-- Dream scheduling + cross-project scope: additive, backward-compatible.
-- Replaces the 1h-rolling-window-only cadence with a configurable per-org schedule.
ALTER TABLE "hivemind"."organizations"
  ADD COLUMN IF NOT EXISTS "cognition_schedule_mode"        VARCHAR(20)  NOT NULL DEFAULT 'nightmode',
  ADD COLUMN IF NOT EXISTS "cognition_window_start_hour"    INTEGER,
  ADD COLUMN IF NOT EXISTS "cognition_window_end_hour"      INTEGER,
  ADD COLUMN IF NOT EXISTS "cognition_schedule_tz"          VARCHAR(64)  NOT NULL DEFAULT 'UTC',
  ADD COLUMN IF NOT EXISTS "cognition_cross_project_enabled" BOOLEAN     NOT NULL DEFAULT false;

-- DOWN (manual, tested):
-- ALTER TABLE "hivemind"."organizations"
--   DROP COLUMN IF EXISTS "cognition_schedule_mode",
--   DROP COLUMN IF EXISTS "cognition_window_start_hour",
--   DROP COLUMN IF EXISTS "cognition_window_end_hour",
--   DROP COLUMN IF EXISTS "cognition_schedule_tz",
--   DROP COLUMN IF EXISTS "cognition_cross_project_enabled";

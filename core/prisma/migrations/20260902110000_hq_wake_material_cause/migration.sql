ALTER TABLE hivemind.hq_schedules
  ADD COLUMN IF NOT EXISTS material_cause_id varchar(240);

CREATE INDEX IF NOT EXISTS hq_schedules_material_cause_idx
  ON hivemind.hq_schedules (runtime_id, runtime_epoch, material_cause_id);

CREATE UNIQUE INDEX IF NOT EXISTS hq_schedules_runtime_epoch_material_cause_unique
  ON hivemind.hq_schedules (runtime_id, runtime_epoch, material_cause_id)
  WHERE material_cause_id IS NOT NULL;

ALTER TABLE hivemind.hq_capability_requests
  ADD COLUMN IF NOT EXISTS correlation_ref varchar(240),
  ADD COLUMN IF NOT EXISTS resume_condition jsonb NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS state_fingerprint varchar(128);

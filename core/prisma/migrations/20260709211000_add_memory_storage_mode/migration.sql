ALTER TABLE hivemind.organizations
  ADD COLUMN IF NOT EXISTS memory_storage_mode varchar(32) NOT NULL DEFAULT 'hybrid';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'organizations_memory_storage_mode_check'
  ) THEN
    ALTER TABLE hivemind.organizations
      ADD CONSTRAINT organizations_memory_storage_mode_check
      CHECK (memory_storage_mode IN ('amr_embedded', 'hybrid', 'hybrid_amr_index', 'byod_amr', 'byod_hybrid'));
  END IF;
END $$;

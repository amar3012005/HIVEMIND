-- ============================================================
-- Migration: P0-2 Org-shared connectors — team_id on platform_integrations
--
-- Adds team_id column (nullable FK to teams.id, SET NULL on delete).
-- Used when target_scope='team' to scope memory ingest to that team.
-- ============================================================

ALTER TABLE "platform_integrations"
  ADD COLUMN IF NOT EXISTS "team_id" UUID;

-- FK: connector can be assigned to a team; if team is deleted, NULL out.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE constraint_name = 'platform_integrations_team_id_fkey'
      AND table_name = 'platform_integrations'
  ) THEN
    ALTER TABLE "platform_integrations"
      ADD CONSTRAINT "platform_integrations_team_id_fkey"
      FOREIGN KEY ("team_id") REFERENCES "teams"("id")
      ON DELETE SET NULL ON UPDATE NO ACTION;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "platform_integrations_team_id_idx"
  ON "platform_integrations"("team_id");

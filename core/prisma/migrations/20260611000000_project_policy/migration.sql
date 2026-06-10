-- Project visibility policy: 'private' (explicit members only),
-- 'team_inherited' (project team's members), 'org_visible' (all org members;
-- guests always excluded — they see only explicit memberships).
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "policy" VARCHAR(20) NOT NULL DEFAULT 'private';
-- Backfill preserves pre-policy behavior: team projects were team-visible,
-- org-level (team_id IS NULL) projects were org-visible.
UPDATE "projects" SET "policy" = CASE WHEN "team_id" IS NULL THEN 'org_visible' ELSE 'team_inherited' END;

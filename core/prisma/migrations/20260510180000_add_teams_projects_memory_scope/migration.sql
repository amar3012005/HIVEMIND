-- ============================================================
-- Migration: Teams + Projects + MemoryScope
-- Adds: teams, team_members, project_members, memory_projects
-- Extends: projects (team_id, status, archived_at)
--          memories (scope, primary_team_id)
-- New enum: MemoryScope
-- ============================================================

-- ── MemoryScope enum ────────────────────────────────────────
CREATE TYPE "MemoryScope" AS ENUM ('personal', 'project', 'team', 'organization');

-- ── teams ───────────────────────────────────────────────────
CREATE TABLE "teams" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(120) NOT NULL,
    "description" TEXT,
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_by" UUID NOT NULL,
    "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ,
    CONSTRAINT "teams_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "teams_org_id_slug_key" ON "teams"("org_id", "slug");
CREATE INDEX "teams_org_id_idx" ON "teams"("org_id");

ALTER TABLE "teams"
  ADD CONSTRAINT "teams_org_id_fkey"
  FOREIGN KEY ("org_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── team_members ────────────────────────────────────────────
CREATE TABLE "team_members" (
    "team_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(50) NOT NULL DEFAULT 'member',
    "added_by" UUID,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "team_members_pkey" PRIMARY KEY ("team_id", "user_id")
);

CREATE INDEX "team_members_user_id_idx" ON "team_members"("user_id");
CREATE INDEX "team_members_team_id_idx" ON "team_members"("team_id");

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "team_members"
  ADD CONSTRAINT "team_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── projects extensions ─────────────────────────────────────
-- Cast existing columns to match new schema spec
ALTER TABLE "projects"
  ALTER COLUMN "name" TYPE VARCHAR(255),
  ALTER COLUMN "slug" TYPE VARCHAR(120);

ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "team_id" UUID;
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "status" VARCHAR(20) NOT NULL DEFAULT 'active';
ALTER TABLE "projects" ADD COLUMN IF NOT EXISTS "archived_at" TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS "projects_team_id_idx" ON "projects"("team_id");
CREATE INDEX IF NOT EXISTS "projects_status_idx" ON "projects"("status");

ALTER TABLE "projects"
  ADD CONSTRAINT "projects_team_id_fkey"
  FOREIGN KEY ("team_id") REFERENCES "teams"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── project_members ─────────────────────────────────────────
CREATE TABLE "project_members" (
    "project_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "role" VARCHAR(50) NOT NULL DEFAULT 'contributor',
    "added_by" UUID,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "project_members_pkey" PRIMARY KEY ("project_id", "user_id")
);

CREATE INDEX "project_members_user_id_idx" ON "project_members"("user_id");
CREATE INDEX "project_members_project_id_idx" ON "project_members"("project_id");

ALTER TABLE "project_members"
  ADD CONSTRAINT "project_members_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "project_members"
  ADD CONSTRAINT "project_members_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

-- ── memory_projects (M2M) ───────────────────────────────────
CREATE TABLE "memory_projects" (
    "memory_id" UUID NOT NULL,
    "project_id" UUID NOT NULL,
    "added_by" UUID,
    "added_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "memory_projects_pkey" PRIMARY KEY ("memory_id", "project_id")
);

CREATE INDEX "memory_projects_memory_id_idx" ON "memory_projects"("memory_id");
CREATE INDEX "memory_projects_project_id_idx" ON "memory_projects"("project_id");

ALTER TABLE "memory_projects"
  ADD CONSTRAINT "memory_projects_memory_id_fkey"
  FOREIGN KEY ("memory_id") REFERENCES "memories"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "memory_projects"
  ADD CONSTRAINT "memory_projects_project_id_fkey"
  FOREIGN KEY ("project_id") REFERENCES "projects"("id")
  ON DELETE CASCADE ON UPDATE NO ACTION;

ALTER TABLE "memory_projects"
  ADD CONSTRAINT "memory_projects_added_by_fkey"
  FOREIGN KEY ("added_by") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- ── memories extensions ─────────────────────────────────────
ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "scope" "MemoryScope" NOT NULL DEFAULT 'personal';

ALTER TABLE "memories"
  ADD COLUMN IF NOT EXISTS "primary_team_id" UUID;

CREATE INDEX IF NOT EXISTS "memories_scope_idx" ON "memories"("scope");
CREATE INDEX IF NOT EXISTS "memories_primary_team_id_idx" ON "memories"("primary_team_id");

ALTER TABLE "memories"
  ADD CONSTRAINT "memories_primary_team_id_fkey"
  FOREIGN KEY ("primary_team_id") REFERENCES "teams"("id")
  ON DELETE SET NULL ON UPDATE NO ACTION;

-- ── Seed default "All Members" team per existing org ────────
-- Owner of org = user with role='owner' in user_organizations; pick any user
-- if no owner found.
DO $$
DECLARE
  o RECORD;
  owner_id UUID;
BEGIN
  FOR o IN SELECT id FROM organizations LOOP
    SELECT user_id INTO owner_id
      FROM user_organizations
      WHERE org_id = o.id
      ORDER BY (role = 'owner') DESC, invited_at ASC
      LIMIT 1;
    IF owner_id IS NOT NULL THEN
      INSERT INTO teams (id, org_id, name, slug, description, is_default, created_by)
      VALUES (gen_random_uuid(), o.id, 'All Members', 'all-members',
              'Default team containing every org member', true, owner_id);
      INSERT INTO team_members (team_id, user_id, role, added_by)
      SELECT (SELECT id FROM teams WHERE org_id = o.id AND is_default = true LIMIT 1),
             uo.user_id, 'member', owner_id
        FROM user_organizations uo WHERE uo.org_id = o.id;
    END IF;
  END LOOP;
END$$;

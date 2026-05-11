-- Migration: P0-4 RBAC — add roles[], is_active, deactivated_at to user_organizations
-- Backfill: existing single `role` column → roles array
-- OrgInvite: add roles[] and team_ids[] for invite-time RBAC
-- The existing `role` column is kept for backward compatibility.

-- 1. Add new columns to user_organizations
ALTER TABLE "user_organizations"
  ADD COLUMN IF NOT EXISTS "roles"          TEXT[]      NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "is_active"      BOOLEAN     NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS "deactivated_at" TIMESTAMPTZ;

-- 2. Backfill roles[] from existing role column.
--    owner → org_owner, admin → org_admin, member → member, viewer → viewer,
--    service_account → service_account; anything else → member as safe default.
UPDATE "user_organizations"
SET "roles" = ARRAY[
  CASE "role"
    WHEN 'owner'           THEN 'org_owner'
    WHEN 'admin'           THEN 'org_admin'
    WHEN 'member'          THEN 'member'
    WHEN 'viewer'          THEN 'viewer'
    WHEN 'service_account' THEN 'service_account'
    ELSE 'member'
  END
]
WHERE "roles" = '{}';

-- 3. Add new columns to org_invites
ALTER TABLE "org_invites"
  ADD COLUMN IF NOT EXISTS "roles"    TEXT[] NOT NULL DEFAULT '{}',
  ADD COLUMN IF NOT EXISTS "team_ids" TEXT[] NOT NULL DEFAULT '{}';

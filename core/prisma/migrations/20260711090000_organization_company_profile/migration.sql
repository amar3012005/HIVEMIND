-- Durable, organization-scoped company context. Existing workspaces remain
-- valid with NULL until an admin completes their workspace profile.
ALTER TABLE "hivemind"."organizations"
  ADD COLUMN IF NOT EXISTS "company_profile" JSONB;

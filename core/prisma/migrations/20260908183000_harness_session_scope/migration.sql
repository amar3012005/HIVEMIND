ALTER TABLE "harness_sessions"
  ADD COLUMN IF NOT EXISTS "scope_kind" VARCHAR(24) NOT NULL DEFAULT 'organization';

ALTER TABLE "harness_sessions"
  ADD CONSTRAINT "harness_sessions_scope_kind_check"
  CHECK (
    ("scope_kind" IN ('organization', 'personal') AND "project_id" IS NULL)
    OR ("scope_kind" = 'project' AND "project_id" IS NOT NULL)
  ) NOT VALID;

ALTER TABLE "harness_sessions"
  VALIDATE CONSTRAINT "harness_sessions_scope_kind_check";

CREATE INDEX IF NOT EXISTS "harness_sessions_scope_updated_idx"
  ON "harness_sessions"("org_id", "user_id", "scope_kind", "updated_at" DESC);

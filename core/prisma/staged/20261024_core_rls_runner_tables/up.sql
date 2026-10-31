-- Staged Core RLS, group A: tenant policies for the tables that non-superuser roles can read.
--
-- NOT APPLIED BY DEFAULT. This directory is outside prisma/migrations, so
-- `prisma migrate deploy` never sees it. An operator applies it by hand with the
-- table-owner (migration) role after approval:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f up.sql
--
-- Runbook: .hivemind/notes/core-rls-runner-tables-runbook-20261024.md
-- Rollback: down.sql. Verification: verify.sql.
--
-- Why these tables: production recon (2026-10-24, read-only) found that the
-- Runtime runner role hivemind_harness_runner (NOSUPERUSER, NOBYPASSRLS) holds
-- direct privileges on tenant tables that have no RLS at all, so it can read
-- every organization's rows whatever tenant context it sets. Core connects as
-- the superuser hivemind_user, which skips every policy, FORCE included, so the
-- statements below change nothing for Core. They constrain only the roles that
-- are named in each policy (TO ...).
--
-- Tenant context: transaction-local app.hivemind_org_id / app.hivemind_user_id,
-- the same settings the harness_*, app_runtime_* and connected-app policies read.
-- An unset or empty setting is NULL after NULLIF, and a NULL comparison matches
-- no row, so a connection without context sees nothing.
--
-- Not in this file (see up-b.sql and the runbook): harness_dream_due, whose
-- Runtime call sites do not all set the context yet.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$
DECLARE
  t text;
  r text;
BEGIN
  FOREACH r IN ARRAY ARRAY['hivemind_harness_runner', 'hivemind_app_runtime', 'hivemind_broker'] LOOP
    IF to_regrole(r) IS NULL THEN
      RAISE EXCEPTION 'role % does not exist; this file targets the production role set', r;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = r AND (rolsuper OR rolbypassrls)) THEN
      RAISE EXCEPTION 'role % bypasses RLS; policies would not constrain it', r;
    END IF;
  END LOOP;
  FOREACH t IN ARRAY ARRAY['memories', 'relationships', 'source_metadata', 'usage_events', 'projects',
    'project_members', 'user_organizations', 'organizations', 'users', 'hq_workflows'] LOOP
    IF to_regclass('hivemind.' || t) IS NULL THEN
      RAISE EXCEPTION 'hivemind.% does not exist', t;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = to_regclass('hivemind.' || t)
      AND polname !~ '_rls_runner(_broker)?$') THEN
      RAISE EXCEPTION 'hivemind.% already has a policy that this file does not own; review before continuing', t;
    END IF;
  END LOOP;
END $$;

-- ---------------------------------------------------------------------------
-- Enable and force. FORCE also binds the table owner unless it is a superuser
-- or BYPASSRLS role (hivemind_user is both, so Core is unaffected today).
-- ---------------------------------------------------------------------------
ALTER TABLE hivemind.memories           ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.memories           FORCE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.relationships      ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.relationships      FORCE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.source_metadata    ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.source_metadata    FORCE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.usage_events       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.usage_events       FORCE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.projects           ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.projects           FORCE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.project_members    ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.project_members    FORCE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.user_organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.user_organizations FORCE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.organizations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.organizations      FORCE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.users              ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.users              FORCE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.hq_workflows       ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.hq_workflows       FORCE  ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- hivemind_harness_runner policies. The runner has SELECT on most of these
-- tables, plus INSERT/UPDATE on projects and INSERT on project_members.
-- ---------------------------------------------------------------------------

-- memories: the organization's rows; another member's personal rows stay hidden.
-- The legacy visibility = 'public' cross-tenant arm is deliberately absent.
DROP POLICY IF EXISTS memories_rls_runner ON hivemind.memories;
CREATE POLICY memories_rls_runner ON hivemind.memories
  AS PERMISSIVE FOR SELECT TO hivemind_harness_runner
  USING (
    org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    AND (scope::text <> 'personal' OR user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
  );

-- relationships: no tenant column; both endpoints must be visible memories.
DROP POLICY IF EXISTS relationships_rls_runner ON hivemind.relationships;
CREATE POLICY relationships_rls_runner ON hivemind.relationships
  AS PERMISSIVE FOR SELECT TO hivemind_harness_runner
  USING (
    EXISTS (SELECT 1 FROM hivemind.memories m WHERE m.id = relationships.from_id)
    AND EXISTS (SELECT 1 FROM hivemind.memories m WHERE m.id = relationships.to_id)
  );

-- source_metadata: no tenant column; follows its memory.
DROP POLICY IF EXISTS source_metadata_rls_runner ON hivemind.source_metadata;
CREATE POLICY source_metadata_rls_runner ON hivemind.source_metadata
  AS PERMISSIVE FOR SELECT TO hivemind_harness_runner
  USING (EXISTS (SELECT 1 FROM hivemind.memories m WHERE m.id = source_metadata.memory_id));

DROP POLICY IF EXISTS usage_events_rls_runner ON hivemind.usage_events;
CREATE POLICY usage_events_rls_runner ON hivemind.usage_events
  AS PERMISSIVE FOR SELECT TO hivemind_harness_runner
  USING (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid);

DROP POLICY IF EXISTS projects_rls_runner ON hivemind.projects;
CREATE POLICY projects_rls_runner ON hivemind.projects
  AS PERMISSIVE FOR ALL TO hivemind_harness_runner
  USING (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid)
  WITH CHECK (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid);

-- project_members: no tenant column; follows its project (projects policy applies inside).
DROP POLICY IF EXISTS project_members_rls_runner ON hivemind.project_members;
CREATE POLICY project_members_rls_runner ON hivemind.project_members
  AS PERMISSIVE FOR ALL TO hivemind_harness_runner
  USING (EXISTS (SELECT 1 FROM hivemind.projects p WHERE p.id = project_members.project_id))
  WITH CHECK (EXISTS (SELECT 1 FROM hivemind.projects p WHERE p.id = project_members.project_id));

DROP POLICY IF EXISTS user_organizations_rls_runner ON hivemind.user_organizations;
CREATE POLICY user_organizations_rls_runner ON hivemind.user_organizations
  AS PERMISSIVE FOR SELECT TO hivemind_harness_runner
  USING (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid);

DROP POLICY IF EXISTS organizations_rls_runner ON hivemind.organizations;
CREATE POLICY organizations_rls_runner ON hivemind.organizations
  AS PERMISSIVE FOR SELECT TO hivemind_harness_runner
  USING (id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid);

-- users: no tenant column; the acting user and the members of the context organization
-- (the user_organizations policy applies inside the subquery).
DROP POLICY IF EXISTS users_rls_runner ON hivemind.users;
CREATE POLICY users_rls_runner ON hivemind.users
  AS PERMISSIVE FOR SELECT TO hivemind_harness_runner
  USING (
    id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid
    OR id IN (SELECT uo.user_id FROM hivemind.user_organizations uo)
  );

-- ---------------------------------------------------------------------------
-- Other non-superuser roles keep exactly the access they have today. Their
-- column-level grants already limit what they can read; FORCE/ENABLE would
-- otherwise deny them every row.
-- ---------------------------------------------------------------------------

-- hivemind_broker resolves an API key to its organization before any tenant
-- context exists (SELECT id, hosting_mode only).
DROP POLICY IF EXISTS organizations_rls_runner_broker ON hivemind.organizations;
CREATE POLICY organizations_rls_runner_broker ON hivemind.organizations
  AS PERMISSIVE FOR SELECT TO hivemind_broker
  USING (true);

-- hivemind_app_runtime reads workflow receipts inside AppRuntimeStore.transaction(),
-- which sets app.hivemind_org_id first (core/src/app-runtime/store.js).
DROP POLICY IF EXISTS hq_workflows_rls_runner ON hivemind.hq_workflows;
CREATE POLICY hq_workflows_rls_runner ON hivemind.hq_workflows
  AS PERMISSIVE FOR SELECT TO hivemind_app_runtime
  USING (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid);

COMMIT;

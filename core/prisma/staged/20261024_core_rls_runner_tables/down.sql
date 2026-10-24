-- Rollback for up.sql (group A). Run with the same owner role that ran up.sql:
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f down.sql
--
-- Restores the previous state: RLS disabled and not forced on these tables, no
-- policies owned by this change. Prior state was recorded by the pre-flight query
-- in the runbook (all ten tables had relrowsecurity = f and no policy). Run
-- down-b.sql first if up-b.sql was applied.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DROP POLICY IF EXISTS memories_rls_runner               ON hivemind.memories;
DROP POLICY IF EXISTS relationships_rls_runner          ON hivemind.relationships;
DROP POLICY IF EXISTS source_metadata_rls_runner        ON hivemind.source_metadata;
DROP POLICY IF EXISTS usage_events_rls_runner           ON hivemind.usage_events;
DROP POLICY IF EXISTS projects_rls_runner               ON hivemind.projects;
DROP POLICY IF EXISTS project_members_rls_runner        ON hivemind.project_members;
DROP POLICY IF EXISTS user_organizations_rls_runner     ON hivemind.user_organizations;
DROP POLICY IF EXISTS organizations_rls_runner          ON hivemind.organizations;
DROP POLICY IF EXISTS organizations_rls_runner_broker   ON hivemind.organizations;
DROP POLICY IF EXISTS users_rls_runner                  ON hivemind.users;
DROP POLICY IF EXISTS hq_workflows_rls_runner           ON hivemind.hq_workflows;

ALTER TABLE hivemind.memories           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.memories           DISABLE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.relationships      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.relationships      DISABLE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.source_metadata    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.source_metadata    DISABLE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.usage_events       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.usage_events       DISABLE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.projects           NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.projects           DISABLE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.project_members    NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.project_members    DISABLE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.user_organizations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.user_organizations DISABLE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.organizations      NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.organizations      DISABLE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.users              NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.users              DISABLE  ROW LEVEL SECURITY;
ALTER TABLE hivemind.hq_workflows       NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.hq_workflows       DISABLE  ROW LEVEL SECURITY;

COMMIT;

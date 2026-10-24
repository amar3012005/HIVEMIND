-- Read-only verification for up.sql (and up-b.sql). Writes nothing; ends in ROLLBACK.
--
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v org_a='<uuid of org A>' -v org_b='<uuid of org B>' -f verify.sql
--
-- The connecting role must be allowed to SET ROLE hivemind_harness_runner
-- (a superuser or a member of it). Output is counts and booleans only.
-- Expected: every "orgB_visible" is 0, every "noctx_visible" is 0, every
-- "orgA_visible" is the org's real row count, and rls_state shows ef for each table.

\echo == 1. RLS state (expect "ef" = enabled and forced)
SELECT c.relname,
       CASE WHEN c.relrowsecurity THEN 'e' ELSE '-' END || CASE WHEN c.relforcerowsecurity THEN 'f' ELSE '-' END AS rls_state,
       (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid) AS policies
FROM pg_class c
WHERE c.relnamespace = 'hivemind'::regnamespace
  AND c.relname IN ('memories','relationships','source_metadata','usage_events','projects',
                    'project_members','user_organizations','organizations','users','hq_workflows')
ORDER BY c.relname;

-- Computed with the connecting role before SET ROLE: ids of users who belong to org B but not to org A.
SELECT coalesce(array_agg(user_id)::text, '{}') AS b_only
FROM hivemind.user_organizations
WHERE org_id = :'org_b'
  AND user_id NOT IN (SELECT user_id FROM hivemind.user_organizations WHERE org_id = :'org_a')
\gset

BEGIN READ ONLY;
SET LOCAL ROLE hivemind_harness_runner;

\echo == 2. No tenant context: expect 0 everywhere
SELECT 'memories' AS t, count(*) AS noctx_visible FROM hivemind.memories
UNION ALL SELECT 'relationships', count(*) FROM hivemind.relationships
UNION ALL SELECT 'source_metadata', count(*) FROM hivemind.source_metadata
UNION ALL SELECT 'usage_events', count(*) FROM hivemind.usage_events
UNION ALL SELECT 'projects', count(*) FROM hivemind.projects
UNION ALL SELECT 'project_members', count(*) FROM hivemind.project_members
UNION ALL SELECT 'user_organizations', count(*) FROM hivemind.user_organizations
UNION ALL SELECT 'organizations', count(*) FROM hivemind.organizations
UNION ALL SELECT 'users', count(*) FROM hivemind.users;

\echo == 3. Context = org A: org B rows visible must be 0
SELECT set_config('app.hivemind_org_id', :'org_a', true) IS NOT NULL AS context_set;
SELECT 'memories' AS t,
       count(*) FILTER (WHERE org_id = :'org_b') AS orgB_visible,
       count(*) FILTER (WHERE org_id = :'org_a') AS orgA_visible,
       count(*) AS total_visible FROM hivemind.memories
UNION ALL SELECT 'usage_events', count(*) FILTER (WHERE org_id = :'org_b'), count(*) FILTER (WHERE org_id = :'org_a'), count(*) FROM hivemind.usage_events
UNION ALL SELECT 'projects', count(*) FILTER (WHERE org_id = :'org_b'), count(*) FILTER (WHERE org_id = :'org_a'), count(*) FROM hivemind.projects
UNION ALL SELECT 'user_organizations', count(*) FILTER (WHERE org_id = :'org_b'), count(*) FILTER (WHERE org_id = :'org_a'), count(*) FROM hivemind.user_organizations
UNION ALL SELECT 'organizations', count(*) FILTER (WHERE id = :'org_b'), count(*) FILTER (WHERE id = :'org_a'), count(*) FROM hivemind.organizations
UNION ALL SELECT 'relationships(from org B memory)',
       count(*) FILTER (WHERE from_id IN (SELECT id FROM hivemind.memories WHERE org_id = :'org_b')),
       count(*) FILTER (WHERE from_id IN (SELECT id FROM hivemind.memories WHERE org_id = :'org_a')), count(*) FROM hivemind.relationships
UNION ALL SELECT 'source_metadata(org B memory)',
       count(*) FILTER (WHERE memory_id IN (SELECT id FROM hivemind.memories WHERE org_id = :'org_b')),
       count(*) FILTER (WHERE memory_id IN (SELECT id FROM hivemind.memories WHERE org_id = :'org_a')), count(*) FROM hivemind.source_metadata
UNION ALL SELECT 'project_members(org B project)',
       count(*) FILTER (WHERE project_id IN (SELECT id FROM hivemind.projects WHERE org_id = :'org_b')),
       count(*) FILTER (WHERE project_id IN (SELECT id FROM hivemind.projects WHERE org_id = :'org_a')), count(*) FROM hivemind.project_members;

\echo == 4. users: members that belong only to org B must be invisible from org A (expect 0)
SELECT count(*) AS orgB_only_members_visible FROM hivemind.users WHERE id = ANY(:'b_only'::uuid[]);
ROLLBACK;

\echo == 5. Other roles keep their access (expect one row each, no error)
BEGIN READ ONLY;
SET LOCAL ROLE hivemind_broker;
SELECT 'broker organizations(id,hosting_mode)' AS t, count(*) > 0 AS readable FROM (SELECT id, hosting_mode FROM hivemind.organizations LIMIT 1) x;
ROLLBACK;

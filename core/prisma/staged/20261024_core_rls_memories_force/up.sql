-- Staged Core RLS enforcement, step 1: non-owner runtime role + FORCE on memories.
--
-- NOT APPLIED BY DEFAULT. This directory is outside prisma/migrations, so
-- `prisma migrate deploy` never sees it. An operator applies it by hand, in
-- staging only, with the migration (table-owner) role:
--
--   psql "$STAGING_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f up.sql
--
-- Production enablement is the owner's (AMAR's) decision. Runbook:
-- .hivemind/notes/core-rls-staging-runbook-20261024.md. Rollback: down.sql.
--
-- What it does:
--   1. Creates hivemind_app NOLOGIN NOSUPERUSER NOBYPASSRLS (refuses to reuse a
--      privileged role of that name) with DML grants on schema hivemind. The
--      operator later sets LOGIN + password out of band; no secret is here.
--   2. Adds transitional pass-through policies, scoped TO hivemind_app only, on
--      the legacy RLS tables that Core does not yet route through the tenant
--      context helper. Several of them have ENABLE ROW LEVEL SECURITY and no
--      policy at all, which would deny every row to a non-owner role and stop
--      Core. These policies do not apply to any other role.
--   3. FORCEs row level security on memories (the table whose read/write paths
--      are routed through withTenant when HIVEMIND_RLS_TENANT_CONTEXT=true).
--      FORCE constrains the table owner too, unless it is a superuser or
--      BYPASSRLS, which skip every policy regardless.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hivemind_app') THEN
    CREATE ROLE hivemind_app NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION NOINHERIT;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hivemind_app'
    AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'Existing hivemind_app role is privileged; refusing to alter it implicitly';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid = m.member WHERE r.rolname = 'hivemind_app') THEN
    RAISE EXCEPTION 'hivemind_app must not be a member of another role';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_class WHERE relnamespace = 'hivemind'::regnamespace
    AND pg_get_userbyid(relowner) = 'hivemind_app') THEN
    RAISE EXCEPTION 'hivemind_app owns objects in schema hivemind; it must stay a non-owner role';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'hivemind.memories'::regclass) THEN
    RAISE EXCEPTION 'hivemind.memories has no RLS policy; FORCE would deny every row';
  END IF;
END $$;

DO $$ BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO hivemind_app', current_database());
END $$;
GRANT USAGE ON SCHEMA hivemind TO hivemind_app;
GRANT USAGE ON SCHEMA public TO hivemind_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA hivemind TO hivemind_app;
GRANT USAGE, SELECT, UPDATE ON ALL SEQUENCES IN SCHEMA hivemind TO hivemind_app;
GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA hivemind TO hivemind_app;
-- Tables created later by the role running this file (the migration owner).
ALTER DEFAULT PRIVILEGES IN SCHEMA hivemind GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO hivemind_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA hivemind GRANT USAGE, SELECT, UPDATE ON SEQUENCES TO hivemind_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA hivemind GRANT EXECUTE ON FUNCTIONS TO hivemind_app;
-- DDL stays with the migration role.
REVOKE CREATE ON SCHEMA hivemind FROM hivemind_app;

-- Transitional pass-through for legacy tables not yet covered by the tenant
-- context helper. Each is removed (and the table FORCEd) in a later stage.
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['users','organizations','user_organizations','platform_integrations',
                           'relationships','vector_embeddings','sessions','sync_logs','audit_logs'] LOOP
    IF to_regclass('hivemind.' || t) IS NOT NULL
       AND (SELECT relrowsecurity FROM pg_class WHERE oid = ('hivemind.' || t)::regclass)
       AND NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = ('hivemind.' || t)::regclass
                       AND polname = t || '_hivemind_app_staged_passthrough') THEN
      EXECUTE format('CREATE POLICY %I ON hivemind.%I AS PERMISSIVE FOR ALL TO hivemind_app USING (true) WITH CHECK (true)',
                     t || '_hivemind_app_staged_passthrough', t);
    END IF;
  END LOOP;
END $$;

ALTER TABLE hivemind.memories ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.memories FORCE ROW LEVEL SECURITY;

COMMIT;

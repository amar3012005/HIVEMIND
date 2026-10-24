-- Rollback for up.sql (staged Core RLS step 1). NOT APPLIED BY DEFAULT.
--
-- Order: first point every Core service back at the previous (owner) database
-- URL and set HIVEMIND_RLS_TENANT_CONTEXT=false, then run with the migration role:
--
--   psql "$STAGING_MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f down.sql
--
-- Restores the pre-up.sql state: memories ENABLEd but not FORCEd (ENABLE is
-- left as it was before up.sql), no pass-through policies, no hivemind_app role.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

ALTER TABLE hivemind.memories NO FORCE ROW LEVEL SECURITY;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['users','organizations','user_organizations','platform_integrations',
                           'relationships','vector_embeddings','sessions','sync_logs','audit_logs'] LOOP
    IF to_regclass('hivemind.' || t) IS NOT NULL THEN
      EXECUTE format('DROP POLICY IF EXISTS %I ON hivemind.%I', t || '_hivemind_app_staged_passthrough', t);
    END IF;
  END LOOP;
END $$;

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hivemind_app') THEN
    IF EXISTS (SELECT 1 FROM pg_class WHERE pg_get_userbyid(relowner) = 'hivemind_app') THEN
      RAISE EXCEPTION 'hivemind_app owns relations; reassign them before dropping the role';
    END IF;
    ALTER ROLE hivemind_app NOLOGIN;
    ALTER DEFAULT PRIVILEGES IN SCHEMA hivemind REVOKE ALL ON TABLES FROM hivemind_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA hivemind REVOKE ALL ON SEQUENCES FROM hivemind_app;
    ALTER DEFAULT PRIVILEGES IN SCHEMA hivemind REVOKE ALL ON FUNCTIONS FROM hivemind_app;
    REVOKE ALL ON ALL TABLES IN SCHEMA hivemind FROM hivemind_app;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA hivemind FROM hivemind_app;
    REVOKE ALL ON ALL FUNCTIONS IN SCHEMA hivemind FROM hivemind_app;
    REVOKE ALL ON SCHEMA hivemind FROM hivemind_app;
    REVOKE ALL ON SCHEMA public FROM hivemind_app;
    EXECUTE format('REVOKE ALL ON DATABASE %I FROM hivemind_app', current_database());
    DROP ROLE hivemind_app;
  END IF;
END $$;

COMMIT;

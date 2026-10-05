-- Operator staging only. Run with psql ON_ERROR_STOP=1 against the reviewed database.
-- No credential or runner configuration changes: role begins NOLOGIN.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hivemind_harness_runner') THEN
    CREATE ROLE hivemind_harness_runner NOLOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOREPLICATION;
  ELSIF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='hivemind_harness_runner'
    AND (rolsuper OR rolbypassrls OR rolcreatedb OR rolcreaterole OR rolreplication)) THEN
    RAISE EXCEPTION 'Existing runner role is privileged; refusing to alter it implicitly';
  END IF;
END $$;
GRANT USAGE ON SCHEMA hivemind TO hivemind_harness_runner;
GRANT SELECT,INSERT,UPDATE,DELETE ON
  hivemind.harness_sessions,hivemind.harness_session_events,hivemind.harness_session_leases,
  hivemind.harness_scheduled_tasks,hivemind.harness_scheduled_due TO hivemind_harness_runner;
GRANT SELECT,INSERT ON hivemind.harness_company_hq TO hivemind_harness_runner;
GRANT SELECT,INSERT,UPDATE ON
  hivemind.harness_dream_settings,hivemind.harness_dream_runs,hivemind.harness_dream_outputs,hivemind.harness_dream_due,
  hivemind.harness_dream_connector_settings,hivemind.harness_dream_connector_contracts,hivemind.harness_dream_connector_evidence
  TO hivemind_harness_runner;
GRANT SELECT ON hivemind.users,hivemind.user_organizations,hivemind.organizations,
  hivemind.projects,hivemind.project_members,hivemind.memories,hivemind.source_metadata,
  hivemind.relationships,hivemind.usage_events TO hivemind_harness_runner;
GRANT INSERT,UPDATE ON hivemind.projects TO hivemind_harness_runner;
GRANT INSERT ON hivemind.project_members TO hivemind_harness_runner;
DO $$ DECLARE seq text; BEGIN
  seq := pg_get_serial_sequence('hivemind.harness_session_events','id');
  IF seq IS NOT NULL THEN EXECUTE format('GRANT USAGE,SELECT ON SEQUENCE %s TO hivemind_harness_runner',seq); END IF;
END $$;
COMMIT;

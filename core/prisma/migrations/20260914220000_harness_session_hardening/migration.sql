-- Post-baseline hardening for native Harness session state. This migration is
-- applied by infra/apply-harness-chat-migrations.sh and recorded in the HIVE
-- migration ledger; it must remain safe to retry after an interrupted release.
SET LOCAL search_path TO hivemind, public;

ALTER TABLE harness_sessions
  ADD COLUMN IF NOT EXISTS scope_kind VARCHAR(24) NOT NULL DEFAULT 'organization';

-- Existing sessions predate scope_kind. A non-null project_id is already the
-- authoritative historical scope signal, so backfill it before the invariant
-- is validated rather than weakening the check or discarding those sessions.
UPDATE harness_sessions
  SET scope_kind = 'project'
  WHERE project_id IS NOT NULL AND scope_kind = 'organization';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'harness_sessions_scope_kind_check'
      AND conrelid = 'hivemind.harness_sessions'::regclass
  ) THEN
    ALTER TABLE harness_sessions
      ADD CONSTRAINT harness_sessions_scope_kind_check
      CHECK (
        (scope_kind IN ('organization', 'personal') AND project_id IS NULL)
        OR (scope_kind = 'project' AND project_id IS NOT NULL)
      ) NOT VALID;
  END IF;
END $$;

ALTER TABLE harness_sessions
  VALIDATE CONSTRAINT harness_sessions_scope_kind_check;

CREATE INDEX IF NOT EXISTS harness_sessions_tenant_updated_idx
  ON harness_sessions(org_id, user_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS harness_sessions_status_updated_idx
  ON harness_sessions(status, updated_at DESC);
CREATE INDEX IF NOT EXISTS harness_sessions_project_updated_idx
  ON harness_sessions(org_id, project_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS harness_sessions_scope_updated_idx
  ON harness_sessions(org_id, user_id, scope_kind, updated_at DESC);
CREATE INDEX IF NOT EXISTS harness_session_events_session_created_idx
  ON harness_session_events(session_id, created_at);
CREATE INDEX IF NOT EXISTS harness_session_events_tenant_created_idx
  ON harness_session_events(org_id, user_id, created_at);
CREATE INDEX IF NOT EXISTS harness_session_leases_recovery_idx
  ON harness_session_leases(expires_at);
CREATE INDEX IF NOT EXISTS harness_session_leases_tenant_expiry_idx
  ON harness_session_leases(org_id, user_id, expires_at);

ALTER TABLE harness_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_session_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_session_events FORCE ROW LEVEL SECURITY;
ALTER TABLE harness_session_leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE harness_session_leases FORCE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'hivemind' AND tablename = 'harness_sessions' AND policyname = 'harness_sessions_tenant_isolation') THEN
    CREATE POLICY harness_sessions_tenant_isolation ON harness_sessions
      USING (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
      WITH CHECK (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'hivemind' AND tablename = 'harness_session_events' AND policyname = 'harness_session_events_tenant_isolation') THEN
    CREATE POLICY harness_session_events_tenant_isolation ON harness_session_events
      USING (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
      WITH CHECK (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'hivemind' AND tablename = 'harness_session_leases' AND policyname = 'harness_session_leases_tenant_isolation') THEN
    CREATE POLICY harness_session_leases_tenant_isolation ON harness_session_leases
      USING (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
      WITH CHECK (org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid AND user_id = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);
  END IF;
END $$;

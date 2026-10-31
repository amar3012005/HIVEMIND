-- Staged Core RLS, group B: harness_dream_due (Runtime-owned scheduling index).
--
-- DO NOT APPLY until the Runtime call sites below set a tenant context or the
-- dream-scheduler setting before touching harness_dream_due. Today three of them
-- do not, and with this policy they would see zero rows (the dreamer would stop
-- admitting and calling back):
--
--   packages/hivemind/dreamer/src/store.ts   DreamStore.accept()  pool.query before scoped()
--   packages/hivemind/dreamer/src/index.ts   run lookup route     pool.query by x-hivemind-tenant-id
--   packages/hivemind/dreamer/src/index.ts   tick()               pool.query scan of all organizations
--
-- DreamStore.claim() already sets app.hivemind_dream_scheduler = 'on' for its
-- cross-organization scan, and every scoped() call sets app.hivemind_org_id, so
-- those paths keep working. The scheduler setting is a plain session setting that
-- any session of the runner role can set; it is a trust-domain marker, not a
-- credential. Moving the scan behind a SECURITY DEFINER function owned by the
-- migration role would remove that, and is the recommended follow-up.
--
-- Apply with the owner role, after up.sql:
--   psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f up-b.sql

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

DO $$ BEGIN
  IF to_regrole('hivemind_harness_runner') IS NULL THEN
    RAISE EXCEPTION 'role hivemind_harness_runner does not exist';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid = 'hivemind.harness_dream_due'::regclass
    AND polname <> 'harness_dream_due_rls_runner') THEN
    RAISE EXCEPTION 'hivemind.harness_dream_due already has a policy that this file does not own';
  END IF;
END $$;

ALTER TABLE hivemind.harness_dream_due ENABLE ROW LEVEL SECURITY;
ALTER TABLE hivemind.harness_dream_due FORCE  ROW LEVEL SECURITY;

DROP POLICY IF EXISTS harness_dream_due_rls_runner ON hivemind.harness_dream_due;
CREATE POLICY harness_dream_due_rls_runner ON hivemind.harness_dream_due
  AS PERMISSIVE FOR ALL TO hivemind_harness_runner
  USING (
    org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    OR current_setting('app.hivemind_dream_scheduler', true) = 'on'
  )
  WITH CHECK (
    org_id = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
    OR current_setting('app.hivemind_dream_scheduler', true) = 'on'
  );

COMMIT;

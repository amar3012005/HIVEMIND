-- Rollback for up-b.sql. Run with the same owner role that ran up-b.sql.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';
DROP POLICY IF EXISTS harness_dream_due_rls_runner ON hivemind.harness_dream_due;
ALTER TABLE hivemind.harness_dream_due NO FORCE ROW LEVEL SECURITY;
ALTER TABLE hivemind.harness_dream_due DISABLE  ROW LEVEL SECURITY;
COMMIT;

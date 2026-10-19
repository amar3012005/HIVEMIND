-- The trusted native controller verifies Control's fenced operation. No central write grant.
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='hivemind_harness_runner') THEN
  GRANT SELECT(id,user_id,ownership_snapshot,lease_owner,lease_until,state,confirmation)
   ON hivemind.account_erasure_operations TO hivemind_harness_runner;
 END IF;
END $$;

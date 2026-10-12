\set ON_ERROR_STOP on
INSERT INTO hivemind.account_erasure_operations(user_id,actor_id,confirmation,ownership_snapshot) VALUES('11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','DELETE','{"orgs":[]}');
DO $$ BEGIN
 BEGIN
 INSERT INTO hivemind.knowledge_documents(user_id) VALUES('11111111-1111-1111-1111-111111111111');
 RAISE EXCEPTION 'fence did not block';
 EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 INSERT INTO hivemind.knowledge_documents(user_id) VALUES('22222222-2222-2222-2222-222222222222');
 IF (SELECT count(*) FROM hivemind.knowledge_documents)<>1 THEN RAISE EXCEPTION 'foreign scope changed'; END IF;
END $$;
INSERT INTO hivemind.account_erasure_operations(user_id,actor_id,confirmation,ownership_snapshot) VALUES('11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','DELETE','{"changed":true}') ON CONFLICT(user_id) WHERE state<>'completed' DO UPDATE SET user_id=EXCLUDED.user_id;
DO $$ BEGIN IF (SELECT ownership_snapshot FROM hivemind.account_erasure_operations LIMIT 1) <> '{"orgs":[]}'::jsonb THEN RAISE EXCEPTION 'snapshot overwritten'; END IF; END $$;
UPDATE hivemind.account_erasure_operations SET lease_owner='33333333-3333-3333-3333-333333333333',lease_until=now()+interval '30 seconds',state='processing';
INSERT INTO hivemind.account_erasure_receipts SELECT id,'r2','hash','erased','{"verified":true}',now() FROM hivemind.account_erasure_operations ON CONFLICT DO NOTHING;
INSERT INTO hivemind.account_erasure_receipts SELECT id,'r2','hash','erased','{"verified":true}',now() FROM hivemind.account_erasure_operations ON CONFLICT DO NOTHING;
DO $$ BEGIN IF (SELECT count(*) FROM hivemind.account_erasure_receipts)<>1 THEN RAISE EXCEPTION 'duplicate receipt'; END IF; END $$;
INSERT INTO hivemind.account_ingestion_leases(user_id,lane,state,created_at) VALUES('11111111-1111-1111-1111-111111111111','vector','active',now()-interval '7 days');
DO $$ BEGIN IF (SELECT count(*) FROM hivemind.account_ingestion_leases WHERE state<>'settled')<>1 THEN RAISE EXCEPTION 'old lease silently drained'; END IF; END $$;

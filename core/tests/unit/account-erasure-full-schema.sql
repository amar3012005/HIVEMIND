\set ON_ERROR_STOP on
INSERT INTO hivemind.users(id,zitadel_user_id,email) VALUES('11111111-1111-1111-1111-111111111111','fictional-erasure-one','erasure-one@example.invalid'),('22222222-2222-2222-2222-222222222222','fictional-erasure-two','erasure-two@example.invalid');
INSERT INTO hivemind.organizations(id,zitadel_org_id,name,slug) VALUES('33333333-3333-3333-3333-333333333333','fictional-org','Fictional erasure fixture','fictional-erasure-fixture');
INSERT INTO hivemind.source_artifacts(id,user_id,org_id,artifact_type,source_platform,checksum,storage_location) VALUES('44444444-4444-4444-4444-444444444444','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','upload','knowledge_upload',repeat('a',64),'kb/fictional'),('55555555-5555-5555-5555-555555555555','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','upload','knowledge_upload',repeat('b',64),'kb/foreign');
INSERT INTO hivemind.knowledge_documents(id,user_id,org_id,source_artifact_id,document_type,source_platform) VALUES('66666666-6666-6666-6666-666666666666','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','44444444-4444-4444-4444-444444444444','file','knowledge_upload'),('77777777-7777-7777-7777-777777777777','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','55555555-5555-5555-5555-555555555555','file','knowledge_upload');
INSERT INTO hivemind.knowledge_segments(document_id,user_id,org_id,segment_type,content,content_hash,segment_index) VALUES('66666666-6666-6666-6666-666666666666','11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','text','fictional text',repeat('c',64),0),('77777777-7777-7777-7777-777777777777','22222222-2222-2222-2222-222222222222','33333333-3333-3333-3333-333333333333','text','foreign fixture',repeat('d',64),0);
INSERT INTO hivemind.knowledge_ingest_jobs(user_id,org_id,scope_type,scope_key,storage_mode,filename,media_kind,checksum,status) VALUES('11111111-1111-1111-1111-111111111111','33333333-3333-3333-3333-333333333333','personal','personal:fixture','hybrid','fictional.txt','document',repeat('a',64),'ready');
INSERT INTO hivemind.account_erasure_operations(user_id,actor_id,confirmation,ownership_snapshot,state,lease_owner,lease_until) VALUES('11111111-1111-1111-1111-111111111111','11111111-1111-1111-1111-111111111111','DELETE','{"organizations":[]}','processing','88888888-8888-8888-8888-888888888888',now()+interval '300 seconds');
DO $$ BEGIN
 BEGIN UPDATE hivemind.knowledge_documents SET title='late' WHERE user_id='11111111-1111-1111-1111-111111111111';RAISE EXCEPTION 'late write admitted';EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
END $$;
BEGIN;
DELETE FROM hivemind.knowledge_ingest_jobs WHERE user_id='11111111-1111-1111-1111-111111111111';
DELETE FROM hivemind.knowledge_documents WHERE user_id='11111111-1111-1111-1111-111111111111';
DELETE FROM hivemind.source_artifacts WHERE user_id='11111111-1111-1111-1111-111111111111' AND NOT EXISTS(SELECT 1 FROM hivemind.knowledge_documents d WHERE d.source_artifact_id=source_artifacts.id);
COMMIT;
DO $$ BEGIN
 IF (SELECT count(*) FROM hivemind.knowledge_segments WHERE user_id='11111111-1111-1111-1111-111111111111')<>0 THEN RAISE EXCEPTION 'dependent segments survived';END IF;
 IF (SELECT count(*) FROM hivemind.knowledge_documents WHERE user_id='22222222-2222-2222-2222-222222222222')<>1 OR (SELECT count(*) FROM hivemind.knowledge_segments WHERE user_id='22222222-2222-2222-2222-222222222222')<>1 THEN RAISE EXCEPTION 'foreign data changed';END IF;
END $$;

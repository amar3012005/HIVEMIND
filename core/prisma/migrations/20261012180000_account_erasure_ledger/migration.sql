-- Durable erasure state preserves identity and source coordinates until reconciled.
CREATE TABLE hivemind.account_erasure_operations (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), user_id uuid NOT NULL,
 actor_id uuid NOT NULL, confirmation text NOT NULL CHECK(confirmation='DELETE'),
 state text NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','processing','blocked','reconciled','completed')),
 ownership_snapshot jsonb NOT NULL, lease_owner uuid, lease_until timestamptz,
 attempts integer NOT NULL DEFAULT 0, next_attempt_at timestamptz NOT NULL DEFAULT now(),
 failure_code text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX account_erasure_one_live_user ON hivemind.account_erasure_operations(user_id) WHERE state <> 'completed';
CREATE TABLE hivemind.account_erasure_receipts (
 operation_id uuid NOT NULL REFERENCES hivemind.account_erasure_operations(id),
 store text NOT NULL, coordinate_hash text NOT NULL, outcome text NOT NULL CHECK(outcome IN ('erased','retained_shared')),
 evidence jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(operation_id,store,coordinate_hash)
);
-- Database-level lock serializes erasure admission with all source writes, including
-- already-running ingest workers. Cleanup deletions remain permitted.
CREATE FUNCTION hivemind.account_erasure_write_fence() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 PERFORM pg_advisory_xact_lock(hashtext('account-erasure:' || NEW.user_id::text));
 IF EXISTS(SELECT 1 FROM hivemind.account_erasure_operations WHERE user_id=NEW.user_id AND state<>'completed') THEN
  RAISE EXCEPTION 'Account source writes are fenced during erasure' USING ERRCODE='55000';
 END IF;
 RETURN NEW;
END $$;
CREATE TRIGGER account_erasure_documents_fence BEFORE INSERT OR UPDATE ON hivemind.knowledge_documents FOR EACH ROW EXECUTE FUNCTION hivemind.account_erasure_write_fence();
CREATE TRIGGER account_erasure_artifacts_fence BEFORE INSERT OR UPDATE ON hivemind.source_artifacts FOR EACH ROW EXECUTE FUNCTION hivemind.account_erasure_write_fence();
CREATE TRIGGER account_erasure_ingest_fence BEFORE INSERT OR UPDATE ON hivemind.knowledge_ingest_jobs FOR EACH ROW EXECUTE FUNCTION hivemind.account_erasure_write_fence();
CREATE TRIGGER account_erasure_segments_fence BEFORE INSERT OR UPDATE ON hivemind.knowledge_segments FOR EACH ROW EXECUTE FUNCTION hivemind.account_erasure_write_fence();
CREATE TRIGGER account_erasure_memories_fence BEFORE INSERT OR UPDATE ON hivemind.memories FOR EACH ROW EXECUTE FUNCTION hivemind.account_erasure_write_fence();
CREATE TABLE hivemind.account_ingestion_leases (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),user_id uuid NOT NULL,lane text NOT NULL,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','settled','unknown')),
 created_at timestamptz NOT NULL DEFAULT now(),settled_at timestamptz
);
CREATE INDEX account_ingestion_unsettled ON hivemind.account_ingestion_leases(user_id) WHERE state<>'settled';

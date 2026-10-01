-- Additive migration. Grants default OFF; no existing Dreaming consent is widened.
BEGIN;
CREATE TABLE IF NOT EXISTS hivemind.harness_dream_connector_settings (
 org_id uuid NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
 user_id uuid NOT NULL REFERENCES hivemind.users(id) ON DELETE CASCADE,
 enabled boolean NOT NULL DEFAULT false,
 revision integer NOT NULL DEFAULT 1,
 accounts jsonb NOT NULL DEFAULT '[]', updated_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,user_id)
);
CREATE TABLE IF NOT EXISTS hivemind.harness_dream_connector_contracts (
 org_id uuid NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
 toolkit text NOT NULL, contracts jsonb NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(org_id,toolkit)
);
CREATE TABLE IF NOT EXISTS hivemind.harness_dream_connector_evidence (
 org_id uuid NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
 id uuid NOT NULL, run_id uuid NOT NULL REFERENCES hivemind.harness_dream_runs(id),
 user_id uuid NOT NULL REFERENCES hivemind.users(id), account_id text NOT NULL,
 title text NOT NULL, content text NOT NULL, provenance jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(org_id,id)
);
CREATE INDEX IF NOT EXISTS harness_dream_connector_evidence_run ON hivemind.harness_dream_connector_evidence(org_id,run_id);
DO $$ DECLARE tab text; BEGIN
 FOREACH tab IN ARRAY ARRAY['harness_dream_connector_settings','harness_dream_connector_contracts','harness_dream_connector_evidence'] LOOP
  EXECUTE format('ALTER TABLE hivemind.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE hivemind.%I FORCE ROW LEVEL SECURITY',tab);
  IF NOT EXISTS(SELECT 1 FROM pg_policies WHERE schemaname='hivemind' AND tablename=tab AND policyname=tab||'_tenant') THEN
   EXECUTE format('CREATE POLICY %I ON hivemind.%I USING (org_id=NULLIF(current_setting(''app.hivemind_org_id'',true),'''')::uuid) WITH CHECK (org_id=NULLIF(current_setting(''app.hivemind_org_id'',true),'''')::uuid)',tab||'_tenant',tab);
  END IF;
 END LOOP;
END $$;
COMMIT;

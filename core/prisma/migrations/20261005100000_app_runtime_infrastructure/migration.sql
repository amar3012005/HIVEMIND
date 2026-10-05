-- Opt-in infrastructure only. No route/composition activation is included.
CREATE TABLE hivemind.app_runtime_apps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL REFERENCES hivemind.organizations(id),
  created_by uuid NOT NULL REFERENCES hivemind.users(id),
  current_version integer NOT NULL CHECK (current_version > 0),
  published_version integer,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,id),
  CHECK (published_version IS NULL OR published_version <= current_version)
);
CREATE TABLE hivemind.app_runtime_versions (
  org_id uuid NOT NULL,
  app_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  spec jsonb NOT NULL CHECK (jsonb_typeof(spec) = 'object'),
  created_by uuid NOT NULL REFERENCES hivemind.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id,app_id,version),
  FOREIGN KEY (org_id,app_id) REFERENCES hivemind.app_runtime_apps(org_id,id) ON DELETE CASCADE
);
ALTER TABLE hivemind.app_runtime_apps ADD CONSTRAINT app_runtime_current_version_fk
  FOREIGN KEY (org_id,id,current_version) REFERENCES hivemind.app_runtime_versions(org_id,app_id,version) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE hivemind.app_runtime_apps ADD CONSTRAINT app_runtime_published_version_fk
  FOREIGN KEY (org_id,id,published_version) REFERENCES hivemind.app_runtime_versions(org_id,app_id,version) DEFERRABLE INITIALLY DEFERRED;
CREATE TABLE hivemind.app_runtime_entities (
  org_id uuid NOT NULL,
  app_id uuid NOT NULL,
  entity_id varchar(80) NOT NULL,
  PRIMARY KEY (org_id,app_id,entity_id),
  FOREIGN KEY (org_id,app_id) REFERENCES hivemind.app_runtime_apps(org_id,id) ON DELETE CASCADE
);
CREATE TABLE hivemind.app_runtime_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  app_id uuid NOT NULL,
  entity_id varchar(80) NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  data jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  created_by uuid NOT NULL REFERENCES hivemind.users(id),
  updated_by uuid NOT NULL REFERENCES hivemind.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (org_id,app_id,id),
  FOREIGN KEY (org_id,app_id,entity_id) REFERENCES hivemind.app_runtime_entities(org_id,app_id,entity_id)
);
CREATE INDEX app_runtime_records_page_idx ON hivemind.app_runtime_records(org_id,app_id,entity_id,id);
CREATE TABLE hivemind.app_runtime_record_relations (
  org_id uuid NOT NULL,
  app_id uuid NOT NULL,
  from_record_id uuid NOT NULL,
  field_id varchar(80) NOT NULL,
  to_record_id uuid NOT NULL,
  PRIMARY KEY (org_id,app_id,from_record_id,field_id),
  FOREIGN KEY (org_id,app_id,from_record_id) REFERENCES hivemind.app_runtime_records(org_id,app_id,id) ON DELETE CASCADE,
  FOREIGN KEY (org_id,app_id,to_record_id) REFERENCES hivemind.app_runtime_records(org_id,app_id,id)
);
CREATE INDEX app_runtime_relations_target_idx ON hivemind.app_runtime_record_relations(org_id,app_id,to_record_id);
CREATE TABLE hivemind.app_runtime_operations (
  org_id uuid NOT NULL REFERENCES hivemind.organizations(id),
  user_id uuid NOT NULL REFERENCES hivemind.users(id),
  operation_id varchar(180) NOT NULL,
  request_hash char(64) NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (org_id,user_id,operation_id)
);
CREATE TABLE hivemind.app_runtime_audit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id uuid NOT NULL,
  app_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES hivemind.users(id),
  operation_id varchar(180) NOT NULL,
  action varchar(40) NOT NULL,
  subject_id varchar(180) NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (org_id,app_id) REFERENCES hivemind.app_runtime_apps(org_id,id)
);
CREATE INDEX app_runtime_audit_app_idx ON hivemind.app_runtime_audit(org_id,app_id,created_at);
-- Defense in depth for organization-shared applications. Membership is checked
-- on every service transaction; settings are transaction-local on pooled clients.
DO $$ DECLARE tab text; BEGIN
  FOREACH tab IN ARRAY ARRAY['app_runtime_apps','app_runtime_versions','app_runtime_entities','app_runtime_records','app_runtime_record_relations','app_runtime_operations','app_runtime_audit'] LOOP
    EXECUTE format('ALTER TABLE hivemind.%I ENABLE ROW LEVEL SECURITY',tab);
    EXECUTE format('ALTER TABLE hivemind.%I FORCE ROW LEVEL SECURITY',tab);
    EXECUTE format('CREATE POLICY %I ON hivemind.%I USING (org_id=NULLIF(current_setting(''app.hivemind_org_id'',true),'''')::uuid) WITH CHECK (org_id=NULLIF(current_setting(''app.hivemind_org_id'',true),'''')::uuid)',tab||'_tenant',tab);
  END LOOP;
END $$;
CREATE FUNCTION hivemind.app_runtime_reject_history_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'app runtime history is append-only'; END $$;
CREATE TRIGGER app_runtime_versions_immutable BEFORE UPDATE OR DELETE ON hivemind.app_runtime_versions
  FOR EACH ROW EXECUTE FUNCTION hivemind.app_runtime_reject_history_mutation();
CREATE TRIGGER app_runtime_audit_immutable BEFORE UPDATE OR DELETE ON hivemind.app_runtime_audit
  FOR EACH ROW EXECUTE FUNCTION hivemind.app_runtime_reject_history_mutation();
CREATE TRIGGER app_runtime_operations_immutable BEFORE UPDATE OR DELETE ON hivemind.app_runtime_operations
  FOR EACH ROW EXECUTE FUNCTION hivemind.app_runtime_reject_history_mutation();

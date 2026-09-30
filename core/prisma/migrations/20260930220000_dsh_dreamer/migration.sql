-- Dreamer content is tenant scoped. The scheduler index contains identity and lease data only.
CREATE TABLE hivemind.harness_dream_settings (
 org_id UUID PRIMARY KEY REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES hivemind.users(id),
 enabled BOOLEAN NOT NULL DEFAULT false,
 revision INTEGER NOT NULL DEFAULT 1 CHECK(revision>0),
 project_id UUID REFERENCES hivemind.projects(id),
 synced_revision INTEGER NOT NULL DEFAULT 0,
 updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE hivemind.harness_dream_runs (
 id UUID PRIMARY KEY,
 org_id UUID NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES hivemind.users(id),
 project_id UUID NOT NULL REFERENCES hivemind.projects(id),
 revision INTEGER NOT NULL,
 occurrence_key TEXT NOT NULL,
 occurrence_id TEXT NOT NULL,
 trigger_id TEXT NOT NULL,
 parent_id TEXT NOT NULL,
 child_id TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued','running','completed','failed')),
 checkpoint JSONB NOT NULL DEFAULT '{}',
 output_ids TEXT[] NOT NULL DEFAULT '{}',
 lease_token TEXT, lease_until TIMESTAMPTZ,
 attempts INTEGER NOT NULL DEFAULT 0,
 error_code TEXT, receipt_id TEXT,
 callback_pending BOOLEAN NOT NULL DEFAULT false,
 created_at TIMESTAMPTZ NOT NULL DEFAULT now(), updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
 UNIQUE(org_id,occurrence_key)
);
CREATE INDEX harness_dream_runs_pending_idx ON hivemind.harness_dream_runs(org_id,status,created_at);
CREATE TABLE hivemind.harness_dream_outputs (
 org_id UUID NOT NULL REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
 idempotency_key TEXT NOT NULL,
 run_id UUID NOT NULL REFERENCES hivemind.harness_dream_runs(id),
 candidate JSONB NOT NULL,
 memory_id UUID REFERENCES hivemind.memories(id) ON DELETE SET NULL,
 receipt JSONB,
 PRIMARY KEY(org_id,idempotency_key)
);
CREATE TABLE hivemind.harness_dream_due (
 org_id UUID PRIMARY KEY REFERENCES hivemind.organizations(id) ON DELETE CASCADE,
 user_id UUID NOT NULL REFERENCES hivemind.users(id),
 needs_sync BOOLEAN NOT NULL DEFAULT false,
 has_work BOOLEAN NOT NULL DEFAULT false, has_callbacks BOOLEAN NOT NULL DEFAULT false,
 last_admitted_at TIMESTAMPTZ, lease_token TEXT, lease_until TIMESTAMPTZ
);
DO $$ DECLARE tab TEXT; BEGIN
 FOREACH tab IN ARRAY ARRAY['harness_dream_settings','harness_dream_runs','harness_dream_outputs'] LOOP
  EXECUTE format('ALTER TABLE hivemind.%I ENABLE ROW LEVEL SECURITY',tab);
  EXECUTE format('ALTER TABLE hivemind.%I FORCE ROW LEVEL SECURITY',tab);
  EXECUTE format('CREATE POLICY %I ON hivemind.%I USING (org_id=NULLIF(current_setting(''app.hivemind_org_id'',true),'''')::uuid) WITH CHECK (org_id=NULLIF(current_setting(''app.hivemind_org_id'',true),'''')::uuid)',tab||'_tenant',tab);
 END LOOP;
END $$;
-- Index operations are host-only; it deliberately contains no prompt, memory, or checkpoint.

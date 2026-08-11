CREATE TABLE IF NOT EXISTS "hivemind"."seo_search_console_properties" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "connected_by_user_id" UUID NOT NULL,
  "integration_id" UUID NOT NULL,
  "site_url" TEXT NOT NULL,
  "permission_level" VARCHAR(40) NOT NULL,
  "selected_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seo_search_console_properties_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "seo_gsc_properties_org_key"
  ON "hivemind"."seo_search_console_properties" ("org_id");
CREATE INDEX IF NOT EXISTS "seo_gsc_properties_tenant_user_idx"
  ON "hivemind"."seo_search_console_properties" ("org_id", "connected_by_user_id");
CREATE INDEX IF NOT EXISTS "seo_gsc_properties_integration_idx"
  ON "hivemind"."seo_search_console_properties" ("integration_id");

CREATE TABLE IF NOT EXISTS "hivemind"."seo_search_console_snapshots" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "property_id" UUID NOT NULL,
  "site_url" TEXT NOT NULL,
  "start_date" DATE NOT NULL,
  "end_date" DATE NOT NULL,
  "data_state" VARCHAR(20) NOT NULL DEFAULT 'final',
  "evidence" JSONB NOT NULL,
  "fetched_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "seo_search_console_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "seo_gsc_snapshots_period_key"
  ON "hivemind"."seo_search_console_snapshots" ("org_id", "property_id", "start_date", "end_date");
CREATE INDEX IF NOT EXISTS "seo_gsc_snapshots_org_time_idx"
  ON "hivemind"."seo_search_console_snapshots" ("org_id", "fetched_at" DESC);
CREATE INDEX IF NOT EXISTS "seo_gsc_snapshots_property_time_idx"
  ON "hivemind"."seo_search_console_snapshots" ("property_id", "fetched_at" DESC);

DO $$ BEGIN
  ALTER TABLE "hivemind"."seo_search_console_properties"
    ADD CONSTRAINT "seo_gsc_properties_org_fkey"
    FOREIGN KEY ("org_id") REFERENCES "hivemind"."organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "hivemind"."seo_search_console_properties"
    ADD CONSTRAINT "seo_gsc_properties_user_fkey"
    FOREIGN KEY ("connected_by_user_id") REFERENCES "hivemind"."users"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "hivemind"."seo_search_console_properties"
    ADD CONSTRAINT "seo_gsc_properties_integration_fkey"
    FOREIGN KEY ("integration_id") REFERENCES "hivemind"."platform_integrations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "hivemind"."seo_search_console_snapshots"
    ADD CONSTRAINT "seo_gsc_snapshots_org_fkey"
    FOREIGN KEY ("org_id") REFERENCES "hivemind"."organizations"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE "hivemind"."seo_search_console_snapshots"
    ADD CONSTRAINT "seo_gsc_snapshots_property_fkey"
    FOREIGN KEY ("property_id") REFERENCES "hivemind"."seo_search_console_properties"("id") ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE "platform_integrations"
ADD COLUMN IF NOT EXISTS "connector_metadata" JSONB NOT NULL DEFAULT '{}'::jsonb;

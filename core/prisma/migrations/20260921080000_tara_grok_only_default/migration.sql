-- Grok is the only enabled TARA runtime provider. Preserve historical
-- Deepgram call data/configuration, but normalize every active workspace's
-- runtime selection and the database default for future organizations.
ALTER TABLE "hivemind"."tara_runtime_configs"
  ALTER COLUMN "default_provider" SET DEFAULT 'grok';

UPDATE "hivemind"."tara_runtime_configs"
SET "default_provider" = 'grok',
    "revision" = "revision" + 1,
    "updated_at" = NOW()
WHERE "default_provider" IS DISTINCT FROM 'grok';

CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "hivemind"."hq_runtimes"
  ADD COLUMN IF NOT EXISTS "epoch" UUID;

UPDATE "hivemind"."hq_runtimes"
   SET "epoch" = gen_random_uuid()
 WHERE "epoch" IS NULL;

ALTER TABLE "hivemind"."hq_runtimes"
  ALTER COLUMN "epoch" SET DEFAULT gen_random_uuid(),
  ALTER COLUMN "epoch" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "hq_runtimes_org_epoch_idx"
  ON "hivemind"."hq_runtimes" ("org_id", "epoch");

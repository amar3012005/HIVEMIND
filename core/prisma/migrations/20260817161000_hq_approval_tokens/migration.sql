-- One-click approval links for persona emails. New table, no backfill.
CREATE TABLE IF NOT EXISTS "hivemind"."hq_approval_tokens" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "token" VARCHAR(128) NOT NULL,
  "org_id" UUID NOT NULL,
  "runtime_id" UUID NOT NULL,
  "kind" VARCHAR(24) NOT NULL,
  "run_id" UUID,
  "gate" VARCHAR(120),
  "title" VARCHAR(500) NOT NULL,
  "summary" TEXT NOT NULL,
  "org_name" VARCHAR(255),
  "used_at" TIMESTAMPTZ(6),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),

  CONSTRAINT "hq_approval_tokens_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "hq_approval_tokens_token_key" ON "hivemind"."hq_approval_tokens"("token");
CREATE INDEX IF NOT EXISTS "hq_approval_tokens_org_id_idx" ON "hivemind"."hq_approval_tokens"("org_id");
CREATE INDEX IF NOT EXISTS "hq_approval_tokens_expires_at_idx" ON "hivemind"."hq_approval_tokens"("expires_at");

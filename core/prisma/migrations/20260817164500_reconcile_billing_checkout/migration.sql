-- Reassert the provider-neutral checkout contract for installations whose
-- legacy baseline recorded the original migration before the table existed.
CREATE TABLE IF NOT EXISTS "hivemind"."billing_checkouts" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL REFERENCES "hivemind"."organizations"("id") ON DELETE CASCADE,
  "user_id" UUID NOT NULL REFERENCES "hivemind"."users"("id") ON DELETE RESTRICT,
  "provider" VARCHAR(24) NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "target_plan_id" VARCHAR(50) NOT NULL,
  "offer" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "provider_ref" VARCHAR(255) UNIQUE,
  "expires_at" TIMESTAMPTZ NOT NULL,
  "confirmed_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT "billing_checkouts_status_check" CHECK ("status" IN ('pending', 'confirmed', 'cancelled', 'expired')),
  CONSTRAINT "billing_checkouts_provider_check" CHECK ("provider" IN ('dummy', 'stripe'))
);

CREATE INDEX IF NOT EXISTS "billing_checkouts_org_id_status_created_at_idx"
  ON "hivemind"."billing_checkouts" ("org_id", "status", "created_at");
CREATE INDEX IF NOT EXISTS "billing_checkouts_user_id_created_at_idx"
  ON "hivemind"."billing_checkouts" ("user_id", "created_at");

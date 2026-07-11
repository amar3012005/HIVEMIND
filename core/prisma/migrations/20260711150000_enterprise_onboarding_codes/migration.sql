CREATE TABLE IF NOT EXISTS "hivemind"."enterprise_onboarding_codes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "code_hash" CHAR(64) NOT NULL UNIQUE,
  "label" VARCHAR(255) NOT NULL,
  "hosting_mode" VARCHAR(20),
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "used_at" TIMESTAMPTZ(6),
  "used_by" UUID,
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS "enterprise_onboarding_codes_expires_at_idx"
  ON "hivemind"."enterprise_onboarding_codes" ("expires_at");
CREATE INDEX IF NOT EXISTS "enterprise_onboarding_codes_used_at_idx"
  ON "hivemind"."enterprise_onboarding_codes" ("used_at");

CREATE TABLE IF NOT EXISTS "hivemind"."promotion_codes" (
  "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "code_hash" CHAR(64) NOT NULL UNIQUE,
  "code_hint" VARCHAR(12) NOT NULL,
  "name" VARCHAR(255) NOT NULL,
  "audience" VARCHAR(20) NOT NULL CHECK ("audience" IN ('personal', 'enterprise', 'both')),
  "offer" JSONB NOT NULL,
  "stripe_coupon_id" VARCHAR(64),
  "max_redemptions" INTEGER,
  "redemption_count" INTEGER NOT NULL DEFAULT 0,
  "expires_at" TIMESTAMPTZ(6),
  "revoked_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "promotion_codes_redemption_count_check" CHECK ("redemption_count" >= 0),
  CONSTRAINT "promotion_codes_max_redemptions_check" CHECK ("max_redemptions" IS NULL OR "max_redemptions" > 0)
);
CREATE INDEX IF NOT EXISTS "promotion_codes_audience_idx" ON "hivemind"."promotion_codes" ("audience");
CREATE INDEX IF NOT EXISTS "promotion_codes_expires_at_idx" ON "hivemind"."promotion_codes" ("expires_at");
ALTER TABLE "hivemind"."organizations" ADD COLUMN IF NOT EXISTS "commercial_terms" JSONB;
ALTER TABLE "hivemind"."organizations" ADD COLUMN IF NOT EXISTS "promotion_code_id" UUID;

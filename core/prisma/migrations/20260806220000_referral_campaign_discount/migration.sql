-- Two-phase referral campaign discount economics: one admin-generated code
-- configures both the onboarding grace period and the recurring runway phase,
-- with either a percentage-off or a fixed amount-off discount.
ALTER TABLE "referral_campaigns"
  ADD COLUMN "discount_kind" VARCHAR(20) NOT NULL DEFAULT 'none',
  ADD COLUMN "discount_percent" INTEGER,
  ADD COLUMN "discount_amount_cents" INTEGER,
  ADD COLUMN "discount_currency" VARCHAR(3) NOT NULL DEFAULT 'EUR',
  ADD COLUMN "runway_interval_months" INTEGER NOT NULL DEFAULT 1;

ALTER TABLE "referral_campaigns"
  ADD CONSTRAINT "referral_campaigns_discount_kind_check"
  CHECK ("discount_kind" IN ('none', 'percentage', 'fixed'));

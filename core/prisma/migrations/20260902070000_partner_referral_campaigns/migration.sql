CREATE TABLE "partner_referral_campaigns" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "promotion_id" UUID NOT NULL,
  "referrer_display_name" VARCHAR(120) NOT NULL,
  "referrer_email" VARCHAR(255) NOT NULL,
  "referrer_email_hash" CHAR(64) NOT NULL,
  "referrer_email_hint" VARCHAR(160) NOT NULL,
  "share_token_hash" CHAR(64) NOT NULL,
  "share_token_version" INTEGER NOT NULL DEFAULT 1,
  "welcome_message" TEXT,
  "delivery_status" VARCHAR(24) NOT NULL DEFAULT 'not_sent',
  "last_delivery_error" VARCHAR(240),
  "sent_at" TIMESTAMPTZ(6),
  "last_sent_at" TIMESTAMPTZ(6),
  "visit_count" INTEGER NOT NULL DEFAULT 0,
  "accepted_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "partner_referral_campaigns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "partner_referral_campaigns_promotion_id_fkey" FOREIGN KEY ("promotion_id") REFERENCES "promotions"("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "partner_referral_campaigns_promotion_id_key" ON "partner_referral_campaigns"("promotion_id");
CREATE UNIQUE INDEX "partner_referral_campaigns_share_token_hash_key" ON "partner_referral_campaigns"("share_token_hash");
CREATE INDEX "partner_referral_campaigns_referrer_email_hash_created_at_idx" ON "partner_referral_campaigns"("referrer_email_hash", "created_at");

ALTER TABLE "promotion_redemptions" ADD COLUMN "partner_referral_campaign_id" UUID;
CREATE INDEX "promotion_redemptions_partner_referral_campaign_id_idx" ON "promotion_redemptions"("partner_referral_campaign_id");
ALTER TABLE "promotion_redemptions" ADD CONSTRAINT "promotion_redemptions_partner_referral_campaign_id_fkey" FOREIGN KEY ("partner_referral_campaign_id") REFERENCES "partner_referral_campaigns"("id") ON DELETE SET NULL ON UPDATE CASCADE;

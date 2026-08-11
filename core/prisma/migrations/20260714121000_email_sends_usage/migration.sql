-- Value-action metering: count approved outbound email sends per org.
-- Down: ALTER TABLE ... DROP COLUMN "emailSends"; (both tables)
ALTER TABLE "hivemind"."OrgUsage" ADD COLUMN IF NOT EXISTS "emailSends" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "hivemind"."OrgUsageDaily" ADD COLUMN IF NOT EXISTS "emailSends" INTEGER NOT NULL DEFAULT 0;

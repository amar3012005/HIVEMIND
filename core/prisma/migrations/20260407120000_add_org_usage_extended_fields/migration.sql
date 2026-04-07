-- AlterTable: Add missing columns to OrgUsage for extended usage tracking
-- Adds: memoriesIngested, deepResearchJobs, webIntelJobs, graphQueries, taraUsage, connectorCount, webIntelDay

ALTER TABLE "OrgUsage"
  ADD COLUMN IF NOT EXISTS "memoriesIngested" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "deepResearchJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "webIntelJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "graphQueries" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "taraUsage" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "connectorCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "webIntelDay" DATE NOT NULL DEFAULT CURRENT_DATE;

-- Add index for webIntelDay lookups (daily limit enforcement)
CREATE INDEX IF NOT EXISTS "idx_org_usage_webIntelDay" ON "OrgUsage"("webIntelDay");

-- Add index for orgId + month lookups (monthly usage queries)
CREATE INDEX IF NOT EXISTS "idx_org_usage_org_month_extended" ON "OrgUsage"("orgId", "month");

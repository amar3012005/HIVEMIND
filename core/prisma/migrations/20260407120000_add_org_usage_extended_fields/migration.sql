-- Ensure OrgUsage exists before extending it.
CREATE TABLE IF NOT EXISTS "OrgUsage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "tokensProcessed" BIGINT NOT NULL DEFAULT 0,
    "searchQueries" BIGINT NOT NULL DEFAULT 0,
    "knowledgeBaseUploads" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrgUsage_orgId_month_key" ON "OrgUsage"("orgId", "month");
CREATE INDEX IF NOT EXISTS "idx_org_usage_org_month" ON "OrgUsage"("orgId", "month");

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

CREATE UNIQUE INDEX IF NOT EXISTS "OrgUsage_orgId_webIntelDay_key" ON "OrgUsage"("orgId", "webIntelDay");

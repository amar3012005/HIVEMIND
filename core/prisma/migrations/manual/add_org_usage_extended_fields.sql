-- Add extended usage tracking fields to OrgUsage table
-- Run this on existing databases to add new columns

ALTER TABLE "OrgUsage"
ADD COLUMN IF NOT EXISTS "memoriesIngested" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "OrgUsage"
ADD COLUMN IF NOT EXISTS "deepResearchJobs" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "OrgUsage"
ADD COLUMN IF NOT EXISTS "webIntelJobs" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "OrgUsage"
ADD COLUMN IF NOT EXISTS "webIntelDay" DATE NOT NULL DEFAULT CURRENT_DATE;

ALTER TABLE "OrgUsage"
ADD COLUMN IF NOT EXISTS "connectorCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "OrgUsage"
ADD COLUMN IF NOT EXISTS "graphQueries" BIGINT NOT NULL DEFAULT 0;

ALTER TABLE "OrgUsage"
ADD COLUMN IF NOT EXISTS "taraUsage" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "idx_org_usage_org_day" ON "OrgUsage" ("orgId", "webIntelDay");

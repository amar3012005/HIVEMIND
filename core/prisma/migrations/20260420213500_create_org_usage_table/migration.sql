-- Create missing OrgUsage table for billing and usage tracking.
-- Some environments already recorded the later ALTER migration without this base table.

CREATE TABLE IF NOT EXISTS "OrgUsage" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "orgId" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "tokensProcessed" BIGINT NOT NULL DEFAULT 0,
    "searchQueries" BIGINT NOT NULL DEFAULT 0,
    "knowledgeBaseUploads" INTEGER NOT NULL DEFAULT 0,
    "memoriesIngested" INTEGER NOT NULL DEFAULT 0,
    "deepResearchJobs" INTEGER NOT NULL DEFAULT 0,
    "webIntelJobs" INTEGER NOT NULL DEFAULT 0,
    "graphQueries" INTEGER NOT NULL DEFAULT 0,
    "taraUsage" INTEGER NOT NULL DEFAULT 0,
    "connectorCount" INTEGER NOT NULL DEFAULT 0,
    "webIntelDay" DATE NOT NULL DEFAULT CURRENT_DATE,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrgUsage_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "OrgUsage_orgId_month_key" ON "OrgUsage"("orgId", "month");
CREATE UNIQUE INDEX IF NOT EXISTS "OrgUsage_orgId_webIntelDay_key" ON "OrgUsage"("orgId", "webIntelDay");
CREATE INDEX IF NOT EXISTS "idx_org_usage_org_month" ON "OrgUsage"("orgId", "month");
CREATE INDEX IF NOT EXISTS "idx_org_usage_webIntelDay" ON "OrgUsage"("webIntelDay");

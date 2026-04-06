-- Usage tracking table for billing
CREATE TABLE IF NOT EXISTS "OrgUsage" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "month" VARCHAR(7) NOT NULL,  -- YYYY-MM format
  "tokensProcessed" BIGINT NOT NULL DEFAULT 0,
  "searchQueries" BIGINT NOT NULL DEFAULT 0,
  "knowledgeBaseUploads" INTEGER NOT NULL DEFAULT 0,
  "memoriesIngested" INTEGER NOT NULL DEFAULT 0,
  "deepResearchJobs" INTEGER NOT NULL DEFAULT 0,
  "webIntelJobs" INTEGER NOT NULL DEFAULT 0,
  "webIntelDay" DATE NOT NULL DEFAULT CURRENT_DATE,
  "connectorCount" INTEGER NOT NULL DEFAULT 0,
  "graphQueries" BIGINT NOT NULL DEFAULT 0,
  "taraUsage" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("orgId", "month")
);

CREATE INDEX IF NOT EXISTS "idx_org_usage_org_month" ON "OrgUsage" ("orgId", "month");
CREATE INDEX IF NOT EXISTS "idx_org_usage_org_day" ON "OrgUsage" ("orgId", "webIntelDay");

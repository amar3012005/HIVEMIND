-- Usage tracking table for billing
CREATE TABLE IF NOT EXISTS "OrgUsage" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "month" VARCHAR(7) NOT NULL,  -- YYYY-MM format
  "tokensProcessed" BIGINT NOT NULL DEFAULT 0,
  "searchQueries" BIGINT NOT NULL DEFAULT 0,
  "knowledgeBaseUploads" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("orgId", "month")
);

CREATE INDEX IF NOT EXISTS "idx_org_usage_org_month" ON "OrgUsage" ("orgId", "month");

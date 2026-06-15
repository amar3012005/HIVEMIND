-- High-level per-day usage counters per org → powers the Usage page daily graphs.
-- Additive (new table), idempotent. OrgUsage stays the monthly rollup.
CREATE TABLE IF NOT EXISTS "OrgUsageDaily" (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "orgId"                uuid NOT NULL,
  day                    date NOT NULL,
  "tokensProcessed"      bigint NOT NULL DEFAULT 0,
  "searchQueries"        bigint NOT NULL DEFAULT 0,
  "knowledgeBaseUploads" integer NOT NULL DEFAULT 0,
  "memoriesIngested"     integer NOT NULL DEFAULT 0,
  "deepResearchJobs"     integer NOT NULL DEFAULT 0,
  "webIntelJobs"         integer NOT NULL DEFAULT 0,
  "graphQueries"         integer NOT NULL DEFAULT 0,
  "taraUsage"            integer NOT NULL DEFAULT 0,
  "updatedAt"            timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "OrgUsageDaily_orgId_day_key" ON "OrgUsageDaily" ("orgId", day);
CREATE INDEX IF NOT EXISTS idx_org_usage_daily_org_day ON "OrgUsageDaily" ("orgId", day);

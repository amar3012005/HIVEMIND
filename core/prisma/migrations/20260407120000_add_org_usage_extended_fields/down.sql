-- DropIndex "OrgUsage_orgId_month_key";
ALTER TABLE "OrgUsage" DROP CONSTRAINT IF EXISTS "OrgUsage_orgId_month_key";

-- AlterTable
ALTER TABLE "OrgUsage"
  ADD COLUMN "memoriesIngested" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "deepResearchJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "webIntelJobs" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "graphQueries" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "taraUsage" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "connectorCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "webIntelDay" DATE NOT NULL DEFAULT CURRENT_DATE;

-- CreateIndex
CREATE INDEX "idx_org_usage_webIntelDay" ON "OrgUsage"("webIntelDay");

-- CreateIndex
CREATE INDEX "idx_org_usage_org_month_extended" ON "OrgUsage"("orgId", "month");

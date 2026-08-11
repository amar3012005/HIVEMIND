-- Durable per-month Knowledge Base pages counter.
-- Backward-compatible, idempotent: safe to re-run and to apply on a live central PG.
-- The kbPages plan gate + meter previously kept this count in-memory only (reset on
-- process restart / drifted across the two core replicas). Persisting it here makes
-- getUsageSummary.kbPages read a durable single-source-of-truth value.

ALTER TABLE "OrgUsage" ADD COLUMN IF NOT EXISTS "knowledgeBasePages" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "OrgUsageDaily" ADD COLUMN IF NOT EXISTS "knowledgeBasePages" INTEGER NOT NULL DEFAULT 0;

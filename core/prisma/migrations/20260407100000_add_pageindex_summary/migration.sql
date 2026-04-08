-- AlterTable
ALTER TABLE "PageIndexNode" 
  ADD COLUMN IF NOT EXISTS "summary" TEXT,
  ADD COLUMN IF NOT EXISTS "summary_updated_at" TIMESTAMPTZ;

-- pipeline_version — which ingestion pipeline produced this row.
--
-- Prerequisite for P2/P3 of the KB ingestion plan. Those phases are TRANSFORMATIVE:
-- P2 changes how many facts a document yields, P3 changes their SHAPE (prose ->
-- atomic). A write-side flag can stop NEW v2 data but cannot restore v1 data — the
-- only real rollback is re-ingestion, and re-ingestion is only SELECTIVE if each row
-- says which pipeline made it. Source bytes are retained (295594e54), so with this
-- column a v1-only re-ingest is possible; without it, it is all-or-nothing.
--
-- Deliberately NOT reusing processing_version: that is a RETRY counter on the ingest
-- job. Overloading it is how the next bug gets written.
--
-- Additive with a non-volatile default → no table rewrite on PG 11+, safe online.
ALTER TABLE "hivemind"."knowledge_documents" ADD COLUMN IF NOT EXISTS "pipeline_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "hivemind"."knowledge_segments"  ADD COLUMN IF NOT EXISTS "pipeline_version" INTEGER NOT NULL DEFAULT 1;
ALTER TABLE "hivemind"."memories"            ADD COLUMN IF NOT EXISTS "pipeline_version" INTEGER NOT NULL DEFAULT 1;

-- Partial indexes: every query that matters asks "what is NOT yet on the new pipeline",
-- so index the minority side rather than the whole table.
CREATE INDEX IF NOT EXISTS "knowledge_documents_pipeline_version_idx" ON "hivemind"."knowledge_documents" ("pipeline_version") WHERE "pipeline_version" < 2;
CREATE INDEX IF NOT EXISTS "knowledge_segments_pipeline_version_idx"  ON "hivemind"."knowledge_segments"  ("pipeline_version") WHERE "pipeline_version" < 2;
CREATE INDEX IF NOT EXISTS "memories_pipeline_version_idx"            ON "hivemind"."memories"            ("pipeline_version") WHERE "pipeline_version" < 2;

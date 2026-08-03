DROP INDEX IF EXISTS "hivemind"."memories_pipeline_version_idx";
DROP INDEX IF EXISTS "hivemind"."knowledge_segments_pipeline_version_idx";
DROP INDEX IF EXISTS "hivemind"."knowledge_documents_pipeline_version_idx";
ALTER TABLE "hivemind"."memories"            DROP COLUMN IF EXISTS "pipeline_version";
ALTER TABLE "hivemind"."knowledge_segments"  DROP COLUMN IF EXISTS "pipeline_version";
ALTER TABLE "hivemind"."knowledge_documents" DROP COLUMN IF EXISTS "pipeline_version";

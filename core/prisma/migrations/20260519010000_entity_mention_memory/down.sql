DROP INDEX IF EXISTS "entity_mentions_memory_id_idx";
ALTER TABLE "entity_mentions" DROP CONSTRAINT IF EXISTS "entity_mentions_memory_id_fkey";
ALTER TABLE "entity_mentions" DROP COLUMN IF EXISTS "memory_id";

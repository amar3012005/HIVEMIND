-- Add memoryId to entity_mentions so canonical memories carry entity links.
ALTER TABLE "entity_mentions"
  ADD COLUMN IF NOT EXISTS "memory_id" UUID;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.table_constraints
    WHERE table_name = 'entity_mentions'
      AND constraint_name = 'entity_mentions_memory_id_fkey'
  ) THEN
    ALTER TABLE "entity_mentions"
      ADD CONSTRAINT "entity_mentions_memory_id_fkey"
      FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS "entity_mentions_memory_id_idx"
  ON "entity_mentions"("memory_id");

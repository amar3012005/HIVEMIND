ALTER TABLE "memories"
ADD COLUMN IF NOT EXISTS "superseded_at" TIMESTAMPTZ(6);

CREATE INDEX IF NOT EXISTS "memories_superseded_at_idx"
ON "memories" ("superseded_at" DESC)
WHERE "superseded_at" IS NOT NULL;

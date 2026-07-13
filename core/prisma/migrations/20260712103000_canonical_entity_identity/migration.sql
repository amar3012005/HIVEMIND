ALTER TABLE "canonical_entities"
ADD COLUMN IF NOT EXISTS "normalized_name" TEXT,
ADD COLUMN IF NOT EXISTS "identity_key" VARCHAR(500);

UPDATE "canonical_entities"
SET "normalized_name" = lower(btrim("canonical_name"))
WHERE "normalized_name" IS NULL;

WITH ranked_email AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY organization_id, entity_kind, lower(primary_email)
           ORDER BY created_at, id
         ) AS position
  FROM canonical_entities
  WHERE primary_email IS NOT NULL
)
UPDATE canonical_entities entity
SET identity_key = 'email:' || lower(btrim(entity.primary_email))
FROM ranked_email ranked
WHERE entity.id = ranked.id AND ranked.position = 1 AND entity.identity_key IS NULL;

ALTER TABLE "canonical_entities"
ALTER COLUMN "normalized_name" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "canonical_entities_org_kind_normalized_idx"
ON "canonical_entities" ("organization_id", "entity_kind", "normalized_name");

CREATE UNIQUE INDEX IF NOT EXISTS "canonical_entities_org_kind_identity_key"
ON "canonical_entities" ("organization_id", "entity_kind", "identity_key")
WHERE "identity_key" IS NOT NULL;

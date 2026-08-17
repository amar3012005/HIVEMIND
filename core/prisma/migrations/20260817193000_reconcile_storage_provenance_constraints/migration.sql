-- Storage-critical, equivalence-safe reconciliation only.
--
-- Historical audit identifiers intentionally have no foreign keys. The audit
-- table is append-only and outlives deleted users, organizations and memories;
-- SET NULL would violate that contract and RESTRICT would prevent erasure.
-- Prisma models those UUIDs as indexed scalar identifiers, not relations.

DELETE FROM "hivemind"."document_table_rows" r
WHERE EXISTS (
  SELECT 1
  FROM "hivemind"."document_tables" t
  LEFT JOIN "hivemind"."knowledge_documents" d ON d."id" = t."document_id"
  WHERE t."id" = r."table_id" AND d."id" IS NULL
);

DELETE FROM "hivemind"."document_tables" t
WHERE NOT EXISTS (
  SELECT 1 FROM "hivemind"."knowledge_documents" d WHERE d."id" = t."document_id"
);

CREATE UNIQUE INDEX IF NOT EXISTS "knowledge_documents_org_canonical_key_uq"
  ON "hivemind"."knowledge_documents" ("org_id", "canonical_ingest_key");

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'document_tables_document_id_fkey'
    AND conrelid = 'hivemind.document_tables'::regclass) THEN
    ALTER TABLE "hivemind"."document_tables"
      ADD CONSTRAINT "document_tables_document_id_fkey"
      FOREIGN KEY ("document_id") REFERENCES "hivemind"."knowledge_documents"("id")
      ON DELETE CASCADE ON UPDATE NO ACTION NOT VALID;
  END IF;
END $$;

ALTER TABLE "hivemind"."document_tables"
  VALIDATE CONSTRAINT "document_tables_document_id_fkey";

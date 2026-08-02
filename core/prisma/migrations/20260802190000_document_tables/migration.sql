-- Persist the parsed spreadsheet/table GRID alongside the prose claims.
--
-- Why: a spreadsheet's questions are "how many", "which is highest", "what is the
-- value for X". Turning it into prose claims answers none of them. Docling already
-- returns {sheet, headers, rows} and the pipeline carried it and dropped it —
-- this is a persistence gap, not an extraction one.
--
-- org_id is on BOTH tables, not only the parent, so a row is unreachable without a
-- tenant filter even if a query forgets the join. GIN on cells makes
-- `cells->>'city' = 'Hannover'` an indexed lookup rather than a scan.

CREATE TABLE IF NOT EXISTS "hivemind"."document_tables" (
  "id"          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "document_id" UUID NOT NULL,
  "org_id"      UUID NOT NULL,
  "user_id"     UUID,
  "sheet"       VARCHAR(255),
  "table_index" INTEGER NOT NULL DEFAULT 0,
  "headers"     TEXT[] NOT NULL DEFAULT '{}',
  "row_count"   INTEGER NOT NULL DEFAULT 0,
  "created_at"  TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "document_tables_document_id_table_index_key" UNIQUE ("document_id", "table_index")
);
CREATE INDEX IF NOT EXISTS "document_tables_org_id_idx"      ON "hivemind"."document_tables" ("org_id");
CREATE INDEX IF NOT EXISTS "document_tables_document_id_idx" ON "hivemind"."document_tables" ("document_id");

CREATE TABLE IF NOT EXISTS "hivemind"."document_table_rows" (
  "id"        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  "table_id"  UUID NOT NULL,
  "org_id"    UUID NOT NULL,
  "row_index" INTEGER NOT NULL,
  "cells"     JSONB NOT NULL,
  CONSTRAINT "document_table_rows_table_id_fkey" FOREIGN KEY ("table_id")
    REFERENCES "hivemind"."document_tables"("id") ON DELETE CASCADE,
  CONSTRAINT "document_table_rows_table_id_row_index_key" UNIQUE ("table_id", "row_index")
);
CREATE INDEX IF NOT EXISTS "document_table_rows_org_id_idx"   ON "hivemind"."document_table_rows" ("org_id");
CREATE INDEX IF NOT EXISTS "document_table_rows_table_id_idx" ON "hivemind"."document_table_rows" ("table_id");
CREATE INDEX IF NOT EXISTS "document_table_rows_cells_gin"    ON "hivemind"."document_table_rows" USING GIN ("cells");

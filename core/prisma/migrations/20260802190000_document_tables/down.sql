-- Down path. Rows cascade from the parent, but drop explicitly so the intent is
-- readable and the order is not left to the FK.
DROP TABLE IF EXISTS "hivemind"."document_table_rows";
DROP TABLE IF EXISTS "hivemind"."document_tables";

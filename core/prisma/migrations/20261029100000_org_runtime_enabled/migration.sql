-- Per-organization "Enable Runtime" switch. Default true keeps every existing
-- company unchanged. Additive and backward-compatible: a constant default is
-- applied without rewriting the table.
ALTER TABLE "hivemind"."organizations" ADD COLUMN IF NOT EXISTS "runtime_enabled" boolean NOT NULL DEFAULT true;

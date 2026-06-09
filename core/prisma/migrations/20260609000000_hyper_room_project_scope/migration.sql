-- HyperRoom project scope: nest a room inside a project HIVEMIND (nullable = org-wide).
-- Additive + backward-compatible: existing rooms keep project_id NULL (org-wide).
ALTER TABLE "hivemind"."hyper_rooms" ADD COLUMN IF NOT EXISTS "project_id" UUID;
CREATE INDEX IF NOT EXISTS "hyper_rooms_project_id_idx" ON "hivemind"."hyper_rooms" ("project_id");

-- Down:
-- DROP INDEX IF EXISTS "hivemind"."hyper_rooms_project_id_idx";
-- ALTER TABLE "hivemind"."hyper_rooms" DROP COLUMN IF EXISTS "project_id";

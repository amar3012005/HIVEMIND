-- Phase P.3 — Memory.project_id formal FK.
-- 5464 memories carry a free-text `project` label that doesn't trace back
-- to a formal Project row. This migration adds project_id (UUID, nullable)
-- + index, and backfills it where the legacy string matches a Project's
-- name OR slug within the same org.

ALTER TABLE hivemind.memories
  ADD COLUMN IF NOT EXISTS project_id uuid NULL;

CREATE INDEX IF NOT EXISTS memories_project_id_idx ON hivemind.memories (project_id);

-- Backfill — match on slug first (slug is unique per org, name may collide).
UPDATE hivemind.memories m
   SET project_id = p.id
  FROM hivemind.projects p
 WHERE m.project_id IS NULL
   AND m.project IS NOT NULL
   AND p.org_id = m.org_id
   AND p.slug = m.project;

UPDATE hivemind.memories m
   SET project_id = p.id
  FROM hivemind.projects p
 WHERE m.project_id IS NULL
   AND m.project IS NOT NULL
   AND p.org_id = m.org_id
   AND p.name = m.project;

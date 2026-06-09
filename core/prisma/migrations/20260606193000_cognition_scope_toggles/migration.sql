-- Cognition scope toggles. Ships for EVERY org/project but defaults OFF —
-- nothing runs until an admin toggles it. Read via raw SQL in
-- cognition-pilot.js (avoids prisma-client-lag on prod, same pattern as
-- retrieval-config.js).
--
-- Org level (workspace-admin choices):
--   cognition_org_enabled       — run cognition over org-visible memories
--   cognition_personal_enabled  — ALSO include the org members' personal/private memories
-- Project level (per-project card toggle):
--   self_evolve_enabled         — run cognition + self-evolution for that project's memories
ALTER TABLE hivemind.organizations
  ADD COLUMN IF NOT EXISTS cognition_org_enabled      boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS cognition_personal_enabled boolean NOT NULL DEFAULT false;

ALTER TABLE hivemind.projects
  ADD COLUMN IF NOT EXISTS self_evolve_enabled boolean NOT NULL DEFAULT false;

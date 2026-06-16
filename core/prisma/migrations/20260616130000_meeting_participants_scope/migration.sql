-- Meeting participants + explicit scope.
-- participants: jsonb array of { type:'member'|'external', id?, name, email?, slackName? }
--   captured at meeting start — used during analysis (speaker reconciliation:
--   SPEAKER_xx → real names) and as entity tags on the saved memory cluster.
-- scope: 'personal' | 'project' | 'team' | 'organization' — decides where the
--   saved 5-memory cluster lands (project_id already exists for the project case).
-- Idempotent (IF NOT EXISTS); the meetings endpoints use raw SQL so this works
-- without a Prisma client regen on the running image.
ALTER TABLE hivemind.meetings
  ADD COLUMN IF NOT EXISTS participants jsonb NOT NULL DEFAULT '[]',
  ADD COLUMN IF NOT EXISTS scope varchar(20);

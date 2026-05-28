-- Phase 4 swarm: every room can have a designated permanent Skeptic
-- whose role is to challenge consensus, surface contradictions, and
-- propose unorthodox angles in R4 of the fixed R1-R5 phase machine.
-- Auto-populate existing rooms with the first Skeptic-lane participant.
ALTER TABLE "hyper_rooms"
  ADD COLUMN IF NOT EXISTS "permanent_skeptic_id" uuid;

CREATE INDEX IF NOT EXISTS "hyper_rooms_skeptic_idx"
  ON "hyper_rooms" ("permanent_skeptic_id");

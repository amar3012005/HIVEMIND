-- The already-shipped `execution_identity` column (work-room-execution.v1) is
-- the tamper-checked TENANT identity envelope for a Work Room turn — it is
-- read-then-validated once by `validate_work_room_execution` and must never be
-- overwritten by anything else. The execution PROFILE (which specialist engine
-- a human turn runs as) is a separate concern: it is chosen once by a Director
-- classification call and must never be reselected on resume/retry/reconnect.
-- Reusing `execution_identity` for this would let a later write silently
-- clobber the identity envelope's own integrity guarantee. Kept as its own
-- column, same pattern as execution_phase/candidate_output/verification_verdict.
ALTER TABLE "hivemind"."hyper_turns"
  ADD COLUMN IF NOT EXISTS "execution_profile" JSONB;

-- Write-once at the database level: the UPDATE that sets this column is
-- always guarded by `WHERE execution_profile IS NULL` (see
-- db.py:persist_work_room_execution_profile). That makes "never reclassify
-- the same turn" an atomic property of the write itself, not an
-- application-level race between a read-check and a later write.

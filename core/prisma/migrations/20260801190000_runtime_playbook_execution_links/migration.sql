ALTER TABLE "hivemind"."hyper_turns"
  ADD COLUMN IF NOT EXISTS "runtime_playbook_run_id" UUID,
  ADD COLUMN IF NOT EXISTS "runtime_stage_id" VARCHAR(120),
  ADD COLUMN IF NOT EXISTS "runtime_checkpoint_sequence" INTEGER,
  ADD COLUMN IF NOT EXISTS "runtime_attempt" INTEGER;

DO $$ BEGIN
  ALTER TABLE "hivemind"."hyper_turns" ADD CONSTRAINT "hyper_turns_runtime_playbook_run_id_fkey"
    FOREIGN KEY ("runtime_playbook_run_id") REFERENCES "hivemind"."runtime_playbook_runs"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE INDEX IF NOT EXISTS "hyper_turns_runtime_playbook_run_id_runtime_checkpoint_sequence_idx" ON "hivemind"."hyper_turns"("runtime_playbook_run_id", "runtime_checkpoint_sequence");
CREATE INDEX IF NOT EXISTS "hyper_turns_runtime_playbook_run_id_runtime_stage_id_runtime_attempt_idx" ON "hivemind"."hyper_turns"("runtime_playbook_run_id", "runtime_stage_id", "runtime_attempt");

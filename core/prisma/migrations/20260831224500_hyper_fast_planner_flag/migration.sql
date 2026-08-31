ALTER TABLE "hivemind"."hyper_turns"
  ADD COLUMN IF NOT EXISTS "fast_planner_mode" VARCHAR(32) NOT NULL DEFAULT 'off';

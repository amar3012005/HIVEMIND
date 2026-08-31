ALTER TABLE "hivemind"."hyper_turns"
  ADD COLUMN IF NOT EXISTS "fast_planner_mode" VARCHAR(32) NOT NULL DEFAULT 'off',
  ADD COLUMN IF NOT EXISTS "fast_planner_version" INTEGER NOT NULL DEFAULT 1;

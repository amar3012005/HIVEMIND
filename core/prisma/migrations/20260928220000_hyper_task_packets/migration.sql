ALTER TABLE "hivemind"."hyper_task_triggers"
  ADD COLUMN "task_packet" jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE "hivemind"."hyper_task_occurrences"
  ADD COLUMN "run_room_id" uuid;

CREATE UNIQUE INDEX "hyper_task_occurrences_run_room_id_key"
  ON "hivemind"."hyper_task_occurrences" ("run_room_id")
  WHERE "run_room_id" IS NOT NULL;

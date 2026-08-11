ALTER TABLE "hivemind"."hq_cycles"
  ADD COLUMN IF NOT EXISTS "runtime_epoch" UUID;

UPDATE "hivemind"."hq_cycles" AS cycle
   SET "runtime_epoch" = runtime."epoch"
  FROM "hivemind"."hq_runtimes" AS runtime
 WHERE cycle."runtime_id" = runtime."id"
   AND cycle."org_id" = runtime."org_id"
   AND cycle."runtime_epoch" IS NULL;

ALTER TABLE "hivemind"."hq_cycles"
  ALTER COLUMN "runtime_epoch" SET NOT NULL;

ALTER TABLE "hivemind"."hyper_work_orders"
  ADD COLUMN IF NOT EXISTS "runtime_epoch" UUID;

UPDATE "hivemind"."hyper_work_orders" AS work_order
   SET "runtime_epoch" = NULLIF(work_order."input_snapshot"->>'runtime_epoch', '')::uuid
 WHERE work_order."hq_cycle_id" IS NOT NULL
   AND work_order."runtime_epoch" IS NULL
   AND work_order."input_snapshot" ? 'runtime_epoch';

ALTER TABLE "hivemind"."hyper_work_results"
  ADD COLUMN IF NOT EXISTS "runtime_epoch" UUID;

UPDATE "hivemind"."hyper_work_results" AS result
   SET "runtime_epoch" = work_order."runtime_epoch"
  FROM "hivemind"."hyper_work_orders" AS work_order
 WHERE result."work_order_id" = work_order."id"
   AND result."runtime_epoch" IS NULL;

CREATE INDEX IF NOT EXISTS "hq_cycles_runtime_epoch_idx"
  ON "hivemind"."hq_cycles" ("runtime_id", "runtime_epoch", "created_at" DESC);

CREATE INDEX IF NOT EXISTS "hyper_work_orders_org_epoch_status_idx"
  ON "hivemind"."hyper_work_orders" ("org_id", "runtime_epoch", "status");

CREATE INDEX IF NOT EXISTS "hyper_work_results_epoch_created_idx"
  ON "hivemind"."hyper_work_results" ("runtime_epoch", "created_at" DESC);

ALTER TABLE "hivemind"."hq_schedules"
  ADD COLUMN IF NOT EXISTS "runtime_epoch" UUID;

UPDATE "hivemind"."hq_schedules" AS schedule
   SET "runtime_epoch" = runtime."epoch"
  FROM "hivemind"."hq_runtimes" AS runtime
 WHERE schedule."runtime_id" = runtime."id"
   AND schedule."org_id" = runtime."org_id"
   AND schedule."runtime_epoch" IS NULL;

ALTER TABLE "hivemind"."hq_schedules"
  ALTER COLUMN "runtime_epoch" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "hq_schedules_runtime_epoch_due_idx"
  ON "hivemind"."hq_schedules" ("runtime_id", "runtime_epoch", "due_at");

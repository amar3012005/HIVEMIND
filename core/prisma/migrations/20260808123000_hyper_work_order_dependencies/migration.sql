-- Durable dependency metadata for adaptive human Work Room turns.
-- Apply manually through the guarded production SQL procedure; never prisma migrate deploy.

ALTER TABLE "hivemind"."hyper_work_orders"
  ADD COLUMN IF NOT EXISTS "plan_step_id" VARCHAR(80),
  ADD COLUMN IF NOT EXISTS "depends_on" JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS "hyper_work_orders_turn_plan_step_idx"
  ON "hivemind"."hyper_work_orders" ("turn_id", "plan_step_id");

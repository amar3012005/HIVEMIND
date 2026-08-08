-- Durable, domain-neutral pause and proposed-handoff metadata for Work Room
-- execution steps. Apply through the guarded manual SQL release procedure;
-- never prisma migrate deploy.

ALTER TABLE "hivemind"."hyper_work_orders"
  ALTER COLUMN "status" TYPE VARCHAR(40),
  ADD COLUMN IF NOT EXISTS "wait_for" JSONB NOT NULL DEFAULT '{}'::jsonb,
  ADD COLUMN IF NOT EXISTS "handoff" JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS "hyper_work_orders_waiting_idx"
  ON "hivemind"."hyper_work_orders" ("org_id", "status")
  WHERE "status" LIKE 'waiting_for_%';

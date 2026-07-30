-- Durable Room work units. Additive and idempotent: apply through the
-- repository's manual production SQL procedure, never prisma migrate deploy.

CREATE TABLE IF NOT EXISTS "hivemind"."hyper_work_orders" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "room_id" UUID NOT NULL,
  "turn_id" UUID NOT NULL,
  "order_key" VARCHAR(80) NOT NULL,
  "kind" VARCHAR(40) NOT NULL,
  "status" VARCHAR(20) NOT NULL DEFAULT 'queued',
  "title" VARCHAR(180) NOT NULL,
  "objective" TEXT NOT NULL,
  "owner_employee_id" UUID,
  "owner_slug" VARCHAR(120),
  "owner_lane" VARCHAR(40),
  "selected_skills" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "required_evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "acceptance_criteria" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "input_snapshot" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "artifact_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "evidence_refs" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "attempt" INTEGER NOT NULL DEFAULT 0,
  "error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "hyper_work_orders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hyper_work_orders_turn_order_key_key" UNIQUE ("turn_id", "order_key"),
  CONSTRAINT "hyper_work_orders_room_fk" FOREIGN KEY ("room_id") REFERENCES "hivemind"."hyper_rooms"("id") ON DELETE CASCADE,
  CONSTRAINT "hyper_work_orders_turn_fk" FOREIGN KEY ("turn_id") REFERENCES "hivemind"."hyper_turns"("id") ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS "hyper_work_orders_org_room_status_idx"
  ON "hivemind"."hyper_work_orders" ("org_id", "room_id", "status");
CREATE INDEX IF NOT EXISTS "hyper_work_orders_turn_idx"
  ON "hivemind"."hyper_work_orders" ("turn_id");

CREATE TABLE IF NOT EXISTS "hivemind"."hyper_work_results" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "work_order_id" UUID NOT NULL REFERENCES "hivemind"."hyper_work_orders"("id") ON DELETE CASCADE,
  "attempt" INTEGER NOT NULL DEFAULT 1,
  "status" VARCHAR(20) NOT NULL DEFAULT 'completed',
  "summary" TEXT NOT NULL,
  "output" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "evidence" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "artifacts" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "usage" JSONB NOT NULL DEFAULT '{}'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT now(),
  CONSTRAINT "hyper_work_results_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "hyper_work_results_order_attempt_key" UNIQUE ("work_order_id", "attempt")
);
CREATE INDEX IF NOT EXISTS "hyper_work_results_order_idx"
  ON "hivemind"."hyper_work_results" ("work_order_id");

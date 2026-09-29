-- Schedule records remain bound to the same tenant identity as native Harness sessions.
CREATE TABLE "harness_scheduled_tasks" (
  "id" VARCHAR(180) NOT NULL PRIMARY KEY,
  "session_id" VARCHAR(180) NOT NULL,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "record" JSONB NOT NULL,
  "status" VARCHAR(16) NOT NULL DEFAULT 'active',
  "scheduled_at" TIMESTAMPTZ(6) NOT NULL,
  "last_delivery" JSONB,
  "delivery_history" JSONB,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "harness_scheduled_tasks_status_check" CHECK ("status" IN ('active', 'inactive')),
  CONSTRAINT "harness_scheduled_tasks_tenant_session_fkey"
    FOREIGN KEY ("session_id", "org_id", "user_id")
    REFERENCES "harness_sessions"("id", "org_id", "user_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);

CREATE UNIQUE INDEX "harness_scheduled_tasks_tenant_identity_key"
  ON "harness_scheduled_tasks"("id", "org_id", "user_id");
CREATE INDEX "harness_scheduled_tasks_tenant_due_idx"
  ON "harness_scheduled_tasks"("org_id", "user_id", "status", "scheduled_at");
CREATE INDEX "harness_scheduled_tasks_session_idx"
  ON "harness_scheduled_tasks"("session_id", "org_id", "user_id");

ALTER TABLE "harness_scheduled_tasks" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "harness_scheduled_tasks" FORCE ROW LEVEL SECURITY;
CREATE POLICY "harness_scheduled_tasks_tenant_isolation" ON "harness_scheduled_tasks"
  USING ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
     AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
  WITH CHECK ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
          AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);

-- Only scheduling metadata is visible to the trusted Host timer. Task content
-- remains in the RLS-protected table and must be read under its tenant scope.
CREATE TABLE "harness_scheduled_due" (
  "task_id" VARCHAR(180) NOT NULL PRIMARY KEY,
  "org_id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "due_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "harness_scheduled_due_task_fkey"
    FOREIGN KEY ("task_id", "org_id", "user_id")
    REFERENCES "harness_scheduled_tasks"("id", "org_id", "user_id")
    ON DELETE CASCADE ON UPDATE NO ACTION
);
CREATE UNIQUE INDEX "harness_scheduled_due_tenant_identity_key"
  ON "harness_scheduled_due"("task_id", "org_id", "user_id");
CREATE INDEX "harness_scheduled_due_claim_idx"
  ON "harness_scheduled_due"("due_at");

ALTER TABLE "harness_scheduled_due" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "harness_scheduled_due" FORCE ROW LEVEL SECURITY;
CREATE POLICY "harness_scheduled_due_tenant_isolation" ON "harness_scheduled_due"
  USING (("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
      AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid)
    OR current_setting('app.hivemind_scheduler', true) = 'on')
  WITH CHECK ("org_id" = NULLIF(current_setting('app.hivemind_org_id', true), '')::uuid
          AND "user_id" = NULLIF(current_setting('app.hivemind_user_id', true), '')::uuid);

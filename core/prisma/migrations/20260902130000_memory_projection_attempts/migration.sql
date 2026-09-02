CREATE TABLE "memory_projection_attempts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "memory_id" UUID NOT NULL,
  "organization_id" UUID NOT NULL,
  "processing_version" INTEGER NOT NULL,
  "admitted_mode" VARCHAR(16) NOT NULL,
  "executor" VARCHAR(32) NOT NULL,
  "workflow_instance_id" VARCHAR(200),
  "status" VARCHAR(32) NOT NULL DEFAULT 'ADMISSION_PENDING',
  "current_stage" VARCHAR(32),
  "stage_receipts" JSONB NOT NULL DEFAULT '{}',
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_projection_attempts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "memory_projection_attempts_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "memory_projection_attempt_memory_version_key" ON "memory_projection_attempts"("memory_id", "processing_version");
CREATE UNIQUE INDEX "memory_projection_attempt_workflow_key" ON "memory_projection_attempts"("workflow_instance_id") WHERE "workflow_instance_id" IS NOT NULL;
CREATE INDEX "memory_projection_attempt_org_status_idx" ON "memory_projection_attempts"("organization_id", "status", "updated_at");

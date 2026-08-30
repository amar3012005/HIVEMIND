ALTER TYPE "RelationshipType" ADD VALUE IF NOT EXISTS 'GroundedIn';
ALTER TYPE "RelationshipType" ADD VALUE IF NOT EXISTS 'DependsOn';
ALTER TYPE "RelationshipType" ADD VALUE IF NOT EXISTS 'Implies';

ALTER TABLE "cognition_run"
  ADD COLUMN "workflow_instance_id" VARCHAR(100),
  ADD COLUMN "pipeline_version" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "trigger_key" VARCHAR(160),
  ADD COLUMN "latched_flags" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "scope_snapshot" JSONB NOT NULL DEFAULT '{}',
  ADD COLUMN "current_stage" VARCHAR(48),
  ADD COLUMN "progress" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "candidate_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "accepted_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "rejected_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "quarantined_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "published_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "profile_update_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "relationship_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "vector_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "model_route" VARCHAR(160),
  ADD COLUMN "embedding_model" VARCHAR(160),
  ADD COLUMN "token_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cost_micros" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "heartbeat_at" TIMESTAMPTZ,
  ADD COLUMN "cancelled_at" TIMESTAMPTZ,
  ADD COLUMN "recovery_status" VARCHAR(32),
  ADD COLUMN "terminal_reason" TEXT;

CREATE UNIQUE INDEX "cognition_run_workflow_instance_id_key" ON "cognition_run"("workflow_instance_id");
CREATE UNIQUE INDEX "cognition_run_org_id_trigger_key_pipeline_version_key" ON "cognition_run"("org_id", "trigger_key", "pipeline_version");
CREATE INDEX "cognition_run_org_id_pipeline_version_status_idx" ON "cognition_run"("org_id", "pipeline_version", "status");
CREATE UNIQUE INDEX "cognition_run_one_active_dream_v2" ON "cognition_run"("org_id", "pipeline_version") WHERE "pipeline_version" = 2 AND "status" = 'running';

CREATE TABLE "cognition_steps" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "run_id" UUID NOT NULL,
  "pipeline_version" INTEGER NOT NULL, "stage_key" VARCHAR(48) NOT NULL,
  "shard_key" VARCHAR(160) NOT NULL DEFAULT 'root', "status" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "attempt" INTEGER NOT NULL DEFAULT 0, "input_digest" VARCHAR(64) NOT NULL,
  "output_receipt" JSONB NOT NULL DEFAULT '{}', "counters" JSONB NOT NULL DEFAULT '{}',
  "lease_expires_at" TIMESTAMPTZ, "error" JSONB, "started_at" TIMESTAMPTZ,
  "completed_at" TIMESTAMPTZ, "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "cognition_steps_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "cognition_steps_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "cognition_run"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "cognition_steps_run_id_pipeline_version_stage_key_shard_key_key" ON "cognition_steps"("run_id", "pipeline_version", "stage_key", "shard_key");
CREATE INDEX "cognition_steps_status_lease_expires_at_idx" ON "cognition_steps"("status", "lease_expires_at");

CREATE TABLE "subject_profiles" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "org_id" UUID NOT NULL,
  "subject_type" VARCHAR(32) NOT NULL, "subject_key" VARCHAR(180) NOT NULL,
  "display_name" VARCHAR(240) NOT NULL, "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "importance" DOUBLE PRECISION NOT NULL DEFAULT 0, "pinned" BOOLEAN NOT NULL DEFAULT false,
  "active" BOOLEAN NOT NULL DEFAULT true, "stable_projection" JSONB NOT NULL DEFAULT '[]',
  "dynamic_projection" JSONB NOT NULL DEFAULT '[]', "projection_version" INTEGER NOT NULL DEFAULT 0,
  "last_activity_at" TIMESTAMPTZ, "last_reconciled_at" TIMESTAMPTZ,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subject_profiles_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "subject_profiles_org_id_subject_type_subject_key_key" ON "subject_profiles"("org_id", "subject_type", "subject_key");
CREATE INDEX "subject_profiles_org_id_active_importance_idx" ON "subject_profiles"("org_id", "active", "importance" DESC);
CREATE INDEX "subject_profiles_org_id_last_activity_at_idx" ON "subject_profiles"("org_id", "last_activity_at" DESC);

CREATE TABLE "subject_profile_facts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "profile_id" UUID NOT NULL,
  "fact_key" VARCHAR(180) NOT NULL, "value" TEXT NOT NULL, "category" VARCHAR(48) NOT NULL,
  "temporal_class" VARCHAR(32) NOT NULL, "confidence" DOUBLE PRECISION NOT NULL,
  "status" VARCHAR(24) NOT NULL DEFAULT 'active', "revision" INTEGER NOT NULL DEFAULT 1,
  "evidence_memory_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "derivation_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[], "supersedes_id" UUID,
  "valid_from" TIMESTAMPTZ, "valid_to" TIMESTAMPTZ, "last_confirmed_at" TIMESTAMPTZ,
  "expires_at" TIMESTAMPTZ, "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subject_profile_facts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subject_profile_facts_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "subject_profiles"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "subject_profile_facts_profile_id_fact_key_revision_key" ON "subject_profile_facts"("profile_id", "fact_key", "revision");
CREATE INDEX "subject_profile_facts_profile_id_status_temporal_class_idx" ON "subject_profile_facts"("profile_id", "status", "temporal_class");
CREATE INDEX "subject_profile_facts_expires_at_idx" ON "subject_profile_facts"("expires_at");

CREATE TABLE "subject_profile_revisions" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "profile_id" UUID NOT NULL, "run_id" UUID NOT NULL,
  "version" INTEGER NOT NULL, "changed_fact_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[],
  "verification" JSONB NOT NULL DEFAULT '{}', "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "subject_profile_revisions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "subject_profile_revisions_profile_id_fkey" FOREIGN KEY ("profile_id") REFERENCES "subject_profiles"("id") ON DELETE CASCADE,
  CONSTRAINT "subject_profile_revisions_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "cognition_run"("id") ON DELETE CASCADE
);
CREATE UNIQUE INDEX "subject_profile_revisions_profile_id_version_key" ON "subject_profile_revisions"("profile_id", "version");
CREATE INDEX "subject_profile_revisions_run_id_idx" ON "subject_profile_revisions"("run_id");

CREATE TABLE "dream_candidates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "run_id" UUID NOT NULL, "org_id" UUID NOT NULL,
  "subject_profile_id" UUID, "deterministic_hash" VARCHAR(64) NOT NULL,
  "type" VARCHAR(40) NOT NULL, "claim" TEXT NOT NULL,
  "source_memory_ids" UUID[] NOT NULL DEFAULT ARRAY[]::UUID[], "confidence" DOUBLE PRECISION NOT NULL DEFAULT 0,
  "risk" VARCHAR(24) NOT NULL DEFAULT 'low', "verdict" VARCHAR(24) NOT NULL DEFAULT 'pending',
  "publication_status" VARCHAR(24) NOT NULL DEFAULT 'pending', "rejection_reasons" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "scope_snapshot" JSONB NOT NULL DEFAULT '{}', "verifier_receipt" JSONB NOT NULL DEFAULT '{}',
  "published_memory_id" UUID, "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "dream_candidates_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "dream_candidates_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "cognition_run"("id") ON DELETE CASCADE,
  CONSTRAINT "dream_candidates_subject_profile_id_fkey" FOREIGN KEY ("subject_profile_id") REFERENCES "subject_profiles"("id") ON DELETE SET NULL
);
CREATE UNIQUE INDEX "dream_candidates_org_id_deterministic_hash_key" ON "dream_candidates"("org_id", "deterministic_hash");
CREATE INDEX "dream_candidates_run_id_verdict_publication_status_idx" ON "dream_candidates"("run_id", "verdict", "publication_status");
CREATE INDEX "dream_candidates_subject_profile_id_created_at_idx" ON "dream_candidates"("subject_profile_id", "created_at" DESC);

CREATE TABLE "derivation_receipts" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "org_id" UUID NOT NULL, "candidate_id" UUID,
  "from_memory_id" UUID NOT NULL, "to_memory_id" UUID NOT NULL,
  "relationship_type" "RelationshipType" NOT NULL, "status" VARCHAR(24) NOT NULL DEFAULT 'queued',
  "attempts" INTEGER NOT NULL DEFAULT 0, "verifier_model" VARCHAR(160),
  "verifier_prompt_hash" VARCHAR(64), "receipt" JSONB NOT NULL DEFAULT '{}', "error" JSONB,
  "created_at" TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP, "processed_at" TIMESTAMPTZ,
  CONSTRAINT "derivation_receipts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "derivation_receipts_org_id_from_memory_id_to_memory_id_relationship_type_key" ON "derivation_receipts"("org_id", "from_memory_id", "to_memory_id", "relationship_type");
CREATE INDEX "derivation_receipts_status_created_at_idx" ON "derivation_receipts"("status", "created_at");

CREATE TABLE "hivemind"."runtime_rollout_policies" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "feature" VARCHAR(120) NOT NULL,
  "mode" VARCHAR(24) NOT NULL DEFAULT 'OFF',
  "metadata" JSONB NOT NULL DEFAULT '{}',
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runtime_rollout_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "runtime_rollout_policies_org_feature_key"
  ON "hivemind"."runtime_rollout_policies"("org_id", "feature");
CREATE INDEX "runtime_rollout_policies_feature_mode_idx"
  ON "hivemind"."runtime_rollout_policies"("feature", "mode");

CREATE TABLE "hivemind"."runtime_release_evidence" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "org_id" UUID NOT NULL,
  "feature" VARCHAR(120) NOT NULL,
  "release_sha" VARCHAR(64) NOT NULL,
  "migration_ids" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "mode" VARCHAR(24) NOT NULL,
  "tests" JSONB NOT NULL DEFAULT '{}',
  "metrics" JSONB NOT NULL DEFAULT '{}',
  "rollback_images" JSONB NOT NULL DEFAULT '{}',
  "operator_decision" TEXT,
  "observed_from" TIMESTAMPTZ(6),
  "observed_to" TIMESTAMPTZ(6),
  "recorded_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "runtime_release_evidence_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "runtime_release_evidence_org_feature_created_idx"
  ON "hivemind"."runtime_release_evidence"("org_id", "feature", "created_at" DESC);

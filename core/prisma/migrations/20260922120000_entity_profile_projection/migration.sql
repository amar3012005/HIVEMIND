CREATE TABLE "entity_profile_facts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL REFERENCES "canonical_entities"("id") ON DELETE CASCADE,
  "canonical_claim_id" uuid NOT NULL REFERENCES "canonical_claims"("id") ON DELETE RESTRICT,
  "fact_class" varchar(20) NOT NULL,
  "fact_key" varchar(160) NOT NULL,
  "value" jsonb NOT NULL,
  "confidence" decimal(4,3) NOT NULL,
  "freshness_at" timestamptz NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'active',
  "decision" varchar(20) NOT NULL DEFAULT 'core',
  "projection_version" integer NOT NULL DEFAULT 1,
  "source_watermark" varchar(128) NOT NULL,
  "supersedes_fact_id" uuid NULL REFERENCES "entity_profile_facts"("id") ON DELETE SET NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "entity_profile_facts_entity_claim_key_version" UNIQUE ("entity_id", "canonical_claim_id", "fact_key", "projection_version")
);
CREATE INDEX "entity_profile_facts_org_entity_status_freshness_idx" ON "entity_profile_facts" ("organization_id", "entity_id", "status", "freshness_at");

CREATE TABLE "entity_profile_fact_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "profile_fact_id" uuid NOT NULL REFERENCES "entity_profile_facts"("id") ON DELETE CASCADE,
  "memory_id" uuid NOT NULL,
  "document_id" uuid NULL,
  "segment_id" uuid NULL,
  "exact_quote" text NULL,
  "source_digest" varchar(64) NOT NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "entity_profile_fact_evidence_profile_memory_digest" UNIQUE ("profile_fact_id", "memory_id", "source_digest")
);
CREATE INDEX "entity_profile_fact_evidence_memory_idx" ON "entity_profile_fact_evidence" ("memory_id");

CREATE TABLE "entity_profile_projection_attempts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "entity_id" uuid NOT NULL,
  "source_watermark" varchar(128) NOT NULL,
  "admitted_mode" varchar(20) NOT NULL,
  "workflow_instance_id" varchar(200) NULL UNIQUE,
  "status" varchar(32) NOT NULL DEFAULT 'ADMISSION_PENDING',
  "stage_receipts" jsonb NOT NULL DEFAULT '{}'::jsonb,
  "retry_count" integer NOT NULL DEFAULT 0,
  "last_error" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  "completed_at" timestamptz NULL,
  CONSTRAINT "entity_profile_attempt_entity_watermark" UNIQUE ("entity_id", "source_watermark")
);
CREATE INDEX "entity_profile_attempt_org_status_updated_idx" ON "entity_profile_projection_attempts" ("organization_id", "status", "updated_at");

CREATE TABLE "entity_profile_reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "profile_fact_id" uuid NOT NULL REFERENCES "entity_profile_facts"("id") ON DELETE CASCADE,
  "kind" varchar(32) NOT NULL,
  "status" varchar(20) NOT NULL DEFAULT 'pending',
  "requested_by_user_id" uuid NULL,
  "resolved_by_user_id" uuid NULL,
  "resolution_note" text NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "resolved_at" timestamptz NULL
);
CREATE INDEX "entity_profile_reviews_org_status_idx" ON "entity_profile_reviews" ("organization_id", "status");

CREATE TABLE "user_entity_identity_links" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "entity_id" uuid NOT NULL REFERENCES "canonical_entities"("id") ON DELETE CASCADE,
  "verification_method" varchar(40) NOT NULL,
  "verified_at" timestamptz NOT NULL,
  "revoked_at" timestamptz NULL,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "user_entity_identity_links_organization_id_user_id_entity_id_key" UNIQUE ("organization_id", "user_id", "entity_id")
);
CREATE INDEX "user_entity_identity_links_org_entity_idx" ON "user_entity_identity_links" ("organization_id", "entity_id");

CREATE TABLE "canonical_predicates" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "name" VARCHAR(80) NOT NULL,
  "version" INTEGER NOT NULL DEFAULT 1, "aliases" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "inverse_name" VARCHAR(80), "subject_kinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "object_kinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[], "risk_class" VARCHAR(20) NOT NULL DEFAULT 'low',
  "active" BOOLEAN NOT NULL DEFAULT true, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "canonical_predicates_pkey" PRIMARY KEY ("id"), CONSTRAINT "canonical_predicates_name_version_key" UNIQUE ("name", "version")
);
CREATE INDEX "canonical_predicates_aliases_idx" ON "canonical_predicates" USING GIN ("aliases");

CREATE TABLE "canonical_claims" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "organization_id" UUID NOT NULL,
  "claim_key" VARCHAR(128) NOT NULL, "kind" VARCHAR(40) NOT NULL DEFAULT 'entity_relation',
  "subject_entity_id" UUID NOT NULL, "predicate_id" UUID NOT NULL, "object_entity_id" UUID,
  "object_literal" JSONB, "qualifiers" JSONB NOT NULL DEFAULT '{}', "confidence" DECIMAL(4,3) NOT NULL DEFAULT 1.0,
  "assertion_status" VARCHAR(32) NOT NULL DEFAULT 'user_asserted', "lifecycle_status" VARCHAR(24) NOT NULL DEFAULT 'active',
  "valid_from" TIMESTAMPTZ(6), "valid_to" TIMESTAMPTZ(6), "known_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processing_version" INTEGER NOT NULL DEFAULT 1, "source_digest" VARCHAR(64) NOT NULL,
  "supersedes_claim_id" UUID, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "canonical_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "canonical_claims_organization_id_claim_key_key" UNIQUE ("organization_id", "claim_key"),
  CONSTRAINT "canonical_claims_subject_entity_id_fkey" FOREIGN KEY ("subject_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT,
  CONSTRAINT "canonical_claims_object_entity_id_fkey" FOREIGN KEY ("object_entity_id") REFERENCES "canonical_entities"("id") ON DELETE RESTRICT,
  CONSTRAINT "canonical_claims_predicate_id_fkey" FOREIGN KEY ("predicate_id") REFERENCES "canonical_predicates"("id") ON DELETE RESTRICT,
  CONSTRAINT "canonical_claims_supersedes_claim_id_fkey" FOREIGN KEY ("supersedes_claim_id") REFERENCES "canonical_claims"("id") ON DELETE SET NULL,
  CONSTRAINT "canonical_claims_object_check" CHECK (("object_entity_id" IS NOT NULL) <> ("object_literal" IS NOT NULL))
);
CREATE INDEX "canonical_claims_org_subject_predicate_idx" ON "canonical_claims"("organization_id", "subject_entity_id", "predicate_id");
CREATE INDEX "canonical_claims_org_object_idx" ON "canonical_claims"("organization_id", "object_entity_id");
CREATE INDEX "canonical_claims_org_valid_idx" ON "canonical_claims"("organization_id", "valid_from", "valid_to");

CREATE TABLE "claim_evidence_links" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(), "claim_id" UUID NOT NULL, "memory_id" UUID NOT NULL,
  "document_id" UUID, "segment_id" UUID, "exact_quote" TEXT, "start_offset" INTEGER, "end_offset" INTEGER,
  "source_digest" VARCHAR(64) NOT NULL, "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "claim_evidence_links_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "claim_evidence_links_claim_memory_digest_key" UNIQUE ("claim_id", "memory_id", "source_digest"),
  CONSTRAINT "claim_evidence_links_claim_id_fkey" FOREIGN KEY ("claim_id") REFERENCES "canonical_claims"("id") ON DELETE CASCADE,
  CONSTRAINT "claim_evidence_links_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE
);
CREATE INDEX "claim_evidence_links_memory_id_idx" ON "claim_evidence_links"("memory_id");

CREATE TABLE "memory_projection_states" (
  "memory_id" UUID NOT NULL, "organization_id" UUID NOT NULL, "admitted_mode" VARCHAR(16) NOT NULL DEFAULT 'off',
  "processing_version" INTEGER NOT NULL DEFAULT 1, "memory_status" VARCHAR(20) NOT NULL DEFAULT 'complete',
  "entities_status" VARCHAR(20) NOT NULL DEFAULT 'pending', "claims_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "lineage_status" VARCHAR(20) NOT NULL DEFAULT 'complete', "vector_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
  "remote_status" VARCHAR(20), "receipt" JSONB, "last_error" TEXT,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "memory_projection_states_pkey" PRIMARY KEY ("memory_id"),
  CONSTRAINT "memory_projection_states_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE
);
CREATE INDEX "memory_projection_states_org_claims_status_idx" ON "memory_projection_states"("organization_id", "claims_status");

CREATE TABLE "canonical_projection_nonces" (
  "nonce" VARCHAR(200) NOT NULL, "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "canonical_projection_nonces_pkey" PRIMARY KEY ("nonce")
);
CREATE INDEX "canonical_projection_nonces_expires_at_idx" ON "canonical_projection_nonces"("expires_at");

INSERT INTO "canonical_predicates" ("name", "aliases", "inverse_name") VALUES
('teaches', ARRAY['teach','is_taught_by'], 'is_taught_by'), ('works_for', ARRAY['employed_by'], NULL),
('manages', ARRAY['manager_of'], 'managed_by'), ('reports_to', ARRAY['reported_to'], 'manages'), ('owns', ARRAY['owner_of'], 'owned_by'),
('uses', ARRAY['used_by'], NULL), ('develops', ARRAY['developed_by'], NULL), ('manufactures', ARRAY['manufactured_by'], NULL),
('located_in', ARRAY['based_in'], NULL), ('member_of', ARRAY['belongs_to'], NULL), ('depends_on', ARRAY['requires'], NULL),
('responsible_for', ARRAY['owns_responsibility_for'], NULL), ('prefers', ARRAY['preference_for'], NULL),
('targets', ARRAY['targeting'], NULL), ('scheduled_for', ARRAY['scheduled_at'], NULL)
ON CONFLICT ("name", "version") DO NOTHING;

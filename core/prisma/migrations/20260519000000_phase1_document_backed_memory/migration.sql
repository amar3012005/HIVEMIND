-- CreateTable
CREATE TABLE "source_artifacts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "artifact_type" VARCHAR(50) NOT NULL,
    "source_platform" VARCHAR(50) NOT NULL,
    "source_id" VARCHAR(500),
    "source_url" TEXT,
    "content_type" VARCHAR(100),
    "size_bytes" BIGINT,
    "checksum" VARCHAR(64) NOT NULL,
    "storage_location" TEXT NOT NULL,
    "payload" JSONB,
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "source_artifacts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_documents" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "source_artifact_id" UUID,
    "document_type" VARCHAR(50) NOT NULL,
    "title" VARCHAR(1000),
    "source_platform" VARCHAR(50) NOT NULL,
    "source_id" VARCHAR(500),
    "source_url" TEXT,
    "thread_id" VARCHAR(500),
    "session_id" VARCHAR(500),
    "parent_document_id" UUID,
    "document_date" TIMESTAMPTZ(6),
    "author" VARCHAR(500),
    "participants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "language" VARCHAR(10) DEFAULT 'en',
    "word_count" INTEGER,
    "parse_status" VARCHAR(20) NOT NULL DEFAULT 'pending',
    "parse_engine" VARCHAR(50),
    "parse_metadata" JSONB NOT NULL DEFAULT '{}',
    "structure_extracted" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(6),

    CONSTRAINT "knowledge_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "knowledge_segments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "document_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "segment_type" VARCHAR(50) NOT NULL,
    "content" TEXT NOT NULL,
    "content_hash" VARCHAR(64) NOT NULL,
    "segment_index" INTEGER NOT NULL,
    "parent_segment_id" UUID,
    "previous_segment_id" UUID,
    "depth" INTEGER NOT NULL DEFAULT 0,
    "start_offset" INTEGER,
    "end_offset" INTEGER,
    "start_page" INTEGER,
    "end_page" INTEGER,
    "word_count" INTEGER,
    "embedding_model" VARCHAR(100) DEFAULT 'mistral-embed',
    "embedding_dimension" INTEGER DEFAULT 1024,
    "vector_stored" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "knowledge_segments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "entity_type" VARCHAR(50) NOT NULL,
    "canonical_name" VARCHAR(500) NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "description" TEXT,
    "external_ids" JSONB NOT NULL DEFAULT '{}',
    "confidence" REAL NOT NULL DEFAULT 0.8,
    "merged_from_ids" UUID[] DEFAULT ARRAY[]::UUID[],
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "mention_count" INTEGER NOT NULL DEFAULT 0,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "entity_mentions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "entity_id" UUID NOT NULL,
    "document_id" UUID,
    "segment_id" UUID,
    "mention_text" VARCHAR(500) NOT NULL,
    "start_offset" INTEGER,
    "end_offset" INTEGER,
    "confidence" REAL NOT NULL DEFAULT 0.9,
    "context" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "entity_mentions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_evidence_links" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "memory_id" UUID NOT NULL,
    "document_id" UUID,
    "segment_id" UUID,
    "link_type" VARCHAR(50) NOT NULL DEFAULT 'supports',
    "confidence" REAL NOT NULL DEFAULT 0.9,
    "excerpt" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_evidence_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memory_derivations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "memory_id" UUID NOT NULL,
    "derivation_method" VARCHAR(50) NOT NULL,
    "derivation_agent" VARCHAR(100),
    "prompt_template" TEXT,
    "input_tokens" INTEGER,
    "output_tokens" INTEGER,
    "confidence" REAL NOT NULL DEFAULT 0.8,
    "review_status" VARCHAR(20) NOT NULL DEFAULT 'unreviewed',
    "reviewed_by" UUID,
    "reviewed_at" TIMESTAMPTZ(6),
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "memory_derivations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "topic_states" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "org_id" UUID NOT NULL,
    "entity_id" UUID,
    "topic_key" VARCHAR(200) NOT NULL,
    "summary" TEXT NOT NULL,
    "last_memory_id" UUID,
    "last_document_id" UUID,
    "memory_count" INTEGER NOT NULL DEFAULT 0,
    "document_count" INTEGER NOT NULL DEFAULT 0,
    "first_seen_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confidence" REAL NOT NULL DEFAULT 0.8,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "topic_states_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "source_artifacts_user_id_org_id_checksum_source_platform_key" ON "source_artifacts"("user_id", "org_id", "checksum", "source_platform");

-- CreateIndex
CREATE INDEX "source_artifacts_user_id_org_id_idx" ON "source_artifacts"("user_id", "org_id");

-- CreateIndex
CREATE INDEX "source_artifacts_source_platform_idx" ON "source_artifacts"("source_platform");

-- CreateIndex
CREATE INDEX "source_artifacts_artifact_type_idx" ON "source_artifacts"("artifact_type");

-- CreateIndex
CREATE INDEX "source_artifacts_checksum_idx" ON "source_artifacts"("checksum");

-- CreateIndex
CREATE INDEX "source_artifacts_created_at_idx" ON "source_artifacts"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_documents_user_id_org_id_source_platform_sourc_key" ON "knowledge_documents"("user_id", "org_id", "source_platform", "source_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_user_id_org_id_idx" ON "knowledge_documents"("user_id", "org_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_document_type_idx" ON "knowledge_documents"("document_type");

-- CreateIndex
CREATE INDEX "knowledge_documents_source_platform_idx" ON "knowledge_documents"("source_platform");

-- CreateIndex
CREATE INDEX "knowledge_documents_thread_id_idx" ON "knowledge_documents"("thread_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_session_id_idx" ON "knowledge_documents"("session_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_parent_document_id_idx" ON "knowledge_documents"("parent_document_id");

-- CreateIndex
CREATE INDEX "knowledge_documents_document_date_idx" ON "knowledge_documents"("document_date" DESC);

-- CreateIndex
CREATE INDEX "knowledge_documents_parse_status_idx" ON "knowledge_documents"("parse_status");

-- CreateIndex
CREATE INDEX "knowledge_documents_tags_idx" ON "knowledge_documents" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "knowledge_documents_created_at_idx" ON "knowledge_documents"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "knowledge_segments_document_id_segment_index_key" ON "knowledge_segments"("document_id", "segment_index");

-- CreateIndex
CREATE INDEX "knowledge_segments_document_id_idx" ON "knowledge_segments"("document_id");

-- CreateIndex
CREATE INDEX "knowledge_segments_user_id_org_id_idx" ON "knowledge_segments"("user_id", "org_id");

-- CreateIndex
CREATE INDEX "knowledge_segments_segment_type_idx" ON "knowledge_segments"("segment_type");

-- CreateIndex
CREATE INDEX "knowledge_segments_parent_segment_id_idx" ON "knowledge_segments"("parent_segment_id");

-- CreateIndex
CREATE INDEX "knowledge_segments_previous_segment_id_idx" ON "knowledge_segments"("previous_segment_id");

-- CreateIndex
CREATE INDEX "knowledge_segments_content_hash_idx" ON "knowledge_segments"("content_hash");

-- CreateIndex
CREATE INDEX "knowledge_segments_vector_stored_idx" ON "knowledge_segments"("vector_stored");

-- CreateIndex
CREATE INDEX "knowledge_segments_created_at_idx" ON "knowledge_segments"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "entities_org_id_entity_type_canonical_name_key" ON "entities"("org_id", "entity_type", "canonical_name");

-- CreateIndex
CREATE INDEX "entities_org_id_entity_type_idx" ON "entities"("org_id", "entity_type");

-- CreateIndex
CREATE INDEX "entities_canonical_name_idx" ON "entities"("canonical_name");

-- CreateIndex
CREATE INDEX "entities_aliases_idx" ON "entities" USING GIN ("aliases");

-- CreateIndex
CREATE INDEX "entities_last_seen_at_idx" ON "entities"("last_seen_at" DESC);

-- CreateIndex
CREATE INDEX "entities_mention_count_idx" ON "entities"("mention_count" DESC);

-- CreateIndex
CREATE INDEX "entity_mentions_entity_id_idx" ON "entity_mentions"("entity_id");

-- CreateIndex
CREATE INDEX "entity_mentions_document_id_idx" ON "entity_mentions"("document_id");

-- CreateIndex
CREATE INDEX "entity_mentions_segment_id_idx" ON "entity_mentions"("segment_id");

-- CreateIndex
CREATE INDEX "entity_mentions_created_at_idx" ON "entity_mentions"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "memory_evidence_links_memory_id_document_id_segment_id_key" ON "memory_evidence_links"("memory_id", "document_id", "segment_id");

-- CreateIndex
CREATE INDEX "memory_evidence_links_memory_id_idx" ON "memory_evidence_links"("memory_id");

-- CreateIndex
CREATE INDEX "memory_evidence_links_document_id_idx" ON "memory_evidence_links"("document_id");

-- CreateIndex
CREATE INDEX "memory_evidence_links_segment_id_idx" ON "memory_evidence_links"("segment_id");

-- CreateIndex
CREATE INDEX "memory_evidence_links_link_type_idx" ON "memory_evidence_links"("link_type");

-- CreateIndex
CREATE UNIQUE INDEX "memory_derivations_memory_id_key" ON "memory_derivations"("memory_id");

-- CreateIndex
CREATE INDEX "memory_derivations_derivation_method_idx" ON "memory_derivations"("derivation_method");

-- CreateIndex
CREATE INDEX "memory_derivations_review_status_idx" ON "memory_derivations"("review_status");

-- CreateIndex
CREATE INDEX "memory_derivations_created_at_idx" ON "memory_derivations"("created_at" DESC);

-- CreateIndex
CREATE UNIQUE INDEX "topic_states_org_id_topic_key_key" ON "topic_states"("org_id", "topic_key");

-- CreateIndex
CREATE INDEX "topic_states_org_id_idx" ON "topic_states"("org_id");

-- CreateIndex
CREATE INDEX "topic_states_entity_id_idx" ON "topic_states"("entity_id");

-- CreateIndex
CREATE INDEX "topic_states_topic_key_idx" ON "topic_states"("topic_key");

-- CreateIndex
CREATE INDEX "topic_states_last_updated_at_idx" ON "topic_states"("last_updated_at" DESC);

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_source_artifact_id_fkey" FOREIGN KEY ("source_artifact_id") REFERENCES "source_artifacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_documents" ADD CONSTRAINT "knowledge_documents_parent_document_id_fkey" FOREIGN KEY ("parent_document_id") REFERENCES "knowledge_documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_segments" ADD CONSTRAINT "knowledge_segments_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_segments" ADD CONSTRAINT "knowledge_segments_parent_segment_id_fkey" FOREIGN KEY ("parent_segment_id") REFERENCES "knowledge_segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "knowledge_segments" ADD CONSTRAINT "knowledge_segments_previous_segment_id_fkey" FOREIGN KEY ("previous_segment_id") REFERENCES "knowledge_segments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "entity_mentions" ADD CONSTRAINT "entity_mentions_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "knowledge_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_evidence_links" ADD CONSTRAINT "memory_evidence_links_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_evidence_links" ADD CONSTRAINT "memory_evidence_links_document_id_fkey" FOREIGN KEY ("document_id") REFERENCES "knowledge_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_evidence_links" ADD CONSTRAINT "memory_evidence_links_segment_id_fkey" FOREIGN KEY ("segment_id") REFERENCES "knowledge_segments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memory_derivations" ADD CONSTRAINT "memory_derivations_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "topic_states" ADD CONSTRAINT "topic_states_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities"("id") ON DELETE CASCADE ON UPDATE CASCADE;

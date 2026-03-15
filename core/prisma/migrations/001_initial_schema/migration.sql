-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "zitadel_user_id" VARCHAR(255) NOT NULL,
    "email" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(255),
    "avatar_url" TEXT,
    "timezone" VARCHAR(50) DEFAULT 'UTC',
    "locale" VARCHAR(10) DEFAULT 'en',
    "encryption_key_id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "encryption_key_version" INTEGER DEFAULT 1,
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "last_active_at" TIMESTAMPTZ,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organizations" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "zitadel_org_id" VARCHAR(255) NOT NULL,
    "name" VARCHAR(255) NOT NULL,
    "slug" VARCHAR(100) NOT NULL,
    "data_residency_region" VARCHAR(50) DEFAULT 'eu-central',
    "compliance_flags" TEXT[] DEFAULT ARRAY['GDPR', 'NIS2', 'DORA'],
    "hsm_provider" VARCHAR(50) DEFAULT 'ovhcloud',
    "hsm_key_arn" VARCHAR(255),
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_organizations" (
    "user_id" UUID NOT NULL,
    "org_id" UUID NOT NULL,
    "role" VARCHAR(50) NOT NULL DEFAULT 'member',
    "invited_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "joined_at" TIMESTAMPTZ,

    CONSTRAINT "user_organizations_pkey" PRIMARY KEY ("user_id","org_id")
);

-- CreateTable
CREATE TABLE "platform_integrations" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "platform_type" VARCHAR(50) NOT NULL,
    "platform_user_id" VARCHAR(255),
    "platform_display_name" VARCHAR(255),
    "auth_type" VARCHAR(50) NOT NULL,
    "access_token_encrypted" TEXT,
    "refresh_token_encrypted" TEXT,
    "token_expires_at" TIMESTAMPTZ,
    "api_key_hash" VARCHAR(255),
    "webhook_secret_encrypted" TEXT,
    "oauth_scopes" TEXT[],
    "oauth_granted_at" TIMESTAMPTZ,
    "oauth_last_refreshed" TIMESTAMPTZ,
    "is_active" BOOLEAN DEFAULT TRUE,
    "last_synced_at" TIMESTAMPTZ,
    "sync_status" VARCHAR(50) DEFAULT 'idle',
    "last_error_message" TEXT,
    "last_error_at" TIMESTAMPTZ,
    "consecutive_failures" INTEGER DEFAULT 0,
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "platform_integrations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "memories" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "org_id" UUID,
    "content" TEXT NOT NULL,
    "memory_type" VARCHAR(50) DEFAULT 'fact',
    "title" VARCHAR(500),
    "tags" TEXT[],
    "source_platform" VARCHAR(50),
    "source_session_id" VARCHAR(255),
    "source_message_id" VARCHAR(255),
    "source_url" TEXT,
    "is_latest" BOOLEAN DEFAULT TRUE,
    "supersedes_id" UUID,
    "strength" REAL DEFAULT 1.0,
    "recall_count" INTEGER DEFAULT 0,
    "importance_score" REAL DEFAULT 0.5,
    "last_confirmed_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "document_date" TIMESTAMPTZ,
    "event_dates" TIMESTAMPTZ[],
    "visibility" VARCHAR(50) DEFAULT 'private',
    "shared_with_orgs" UUID[],
    "embedding_model" VARCHAR(100) DEFAULT 'mistral-embed',
    "embedding_dimension" INTEGER DEFAULT 1024,
    "embedding_version" INTEGER DEFAULT 1,
    "processing_basis" VARCHAR(100) DEFAULT 'consent',
    "retention_until" TIMESTAMPTZ,
    "export_blocked" BOOLEAN DEFAULT FALSE,
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "deleted_at" TIMESTAMPTZ,

    CONSTRAINT "memories_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "relationships" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "from_id" UUID NOT NULL,
    "to_id" UUID NOT NULL,
    "type" VARCHAR(50) NOT NULL,
    "confidence" REAL DEFAULT 1.0,
    "inference_model" VARCHAR(100),
    "inference_prompt_hash" VARCHAR(64),
    "metadata" JSONB DEFAULT '{}',
    "created_by" VARCHAR(50) DEFAULT 'system',
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "relationships_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "vector_embeddings" (
    "memory_id" UUID NOT NULL,
    "qdrant_collection" VARCHAR(100) NOT NULL,
    "qdrant_point_id" UUID NOT NULL,
    "embedding_version" INTEGER DEFAULT 1,
    "last_reembedded_at" TIMESTAMPTZ,
    "sync_status" VARCHAR(50) DEFAULT 'synced',
    "last_sync_attempt" TIMESTAMPTZ,
    "sync_error_message" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "vector_embeddings_pkey" PRIMARY KEY ("memory_id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID,
    "platform_type" VARCHAR(50) NOT NULL,
    "platform_session_id" VARCHAR(255),
    "title" VARCHAR(500),
    "message_count" INTEGER DEFAULT 0,
    "token_count" INTEGER DEFAULT 0,
    "memories_injected" UUID[],
    "context_window_used" INTEGER DEFAULT 0,
    "compaction_triggered" BOOLEAN DEFAULT FALSE,
    "started_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "last_activity_at" TIMESTAMPTZ,
    "ended_at" TIMESTAMPTZ,
    "end_reason" VARCHAR(50),
    "auto_captured_count" INTEGER DEFAULT 0,
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sync_logs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID,
    "event_type" VARCHAR(50) NOT NULL,
    "source_platform" VARCHAR(50),
    "target_platform" VARCHAR(50),
    "memory_ids" UUID[],
    "session_id" UUID,
    "payload_hash" VARCHAR(64),
    "status" VARCHAR(50) DEFAULT 'success',
    "error_message" TEXT,
    "retry_count" INTEGER DEFAULT 0,
    "started_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "latency_ms" INTEGER,

    CONSTRAINT "sync_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID,
    "organization_id" UUID,
    "event_type" VARCHAR(100) NOT NULL,
    "event_category" VARCHAR(50),
    "resource_type" VARCHAR(50),
    "resource_id" UUID,
    "action" VARCHAR(50) NOT NULL,
    "old_value" JSONB,
    "new_value" JSONB,
    "ip_address" INET,
    "user_agent" TEXT,
    "platform_type" VARCHAR(50),
    "session_id" UUID,
    "processing_basis" VARCHAR(100),
    "legal_basis_note" TEXT,
    "created_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "data_export_requests" (
    "id" UUID NOT NULL DEFAULT uuid_generate_v4(),
    "user_id" UUID NOT NULL,
    "request_type" VARCHAR(50) NOT NULL,
    "status" VARCHAR(50) DEFAULT 'pending',
    "export_format" VARCHAR(20) DEFAULT 'json',
    "export_url" TEXT,
    "requested_at" TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ,
    "error_message" TEXT,

    CONSTRAINT "data_export_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_zitadel_user_id_key" ON "users"("zitadel_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "users_email_key" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_zitadel_org_id_key" ON "organizations"("zitadel_org_id");

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE INDEX "user_organizations_user_id_idx" ON "user_organizations"("user_id");

-- CreateIndex
CREATE INDEX "user_organizations_org_id_idx" ON "user_organizations"("org_id");

-- CreateIndex
CREATE UNIQUE INDEX "platform_integrations_user_id_platform_type_key" ON "platform_integrations"("user_id", "platform_type");

-- CreateIndex
CREATE INDEX "platform_integrations_user_id_idx" ON "platform_integrations"("user_id");

-- CreateIndex
CREATE INDEX "platform_integrations_platform_type_idx" ON "platform_integrations"("platform_type");

-- CreateIndex
CREATE INDEX "platform_integrations_is_active_sync_status_idx" ON "platform_integrations"("is_active", "sync_status");

-- CreateIndex
CREATE INDEX "memories_user_id_idx" ON "memories"("user_id");

-- CreateIndex
CREATE INDEX "memories_org_id_idx" ON "memories"("org_id");

-- CreateIndex
CREATE INDEX "memories_memory_type_idx" ON "memories"("memory_type");

-- CreateIndex
CREATE INDEX "memories_is_latest_idx" ON "memories"("is_latest") WHERE "is_latest" = TRUE;

-- CreateIndex
CREATE INDEX "memories_source_platform_idx" ON "memories"("source_platform");

-- CreateIndex
CREATE INDEX "memories_document_date_idx" ON "memories"("document_date" DESC);

-- CreateIndex
CREATE INDEX "memories_strength_idx" ON "memories"("strength" DESC);

-- CreateIndex
CREATE INDEX "memories_deleted_at_idx" ON "memories"("deleted_at") WHERE "deleted_at" IS NOT NULL;

-- CreateIndex
CREATE INDEX "memories_tags_idx" ON "memories" USING GIN ("tags");

-- CreateIndex
CREATE INDEX "memories_content_fts_idx" ON "memories" USING GIN (to_tsvector('english', "content"));

-- CreateIndex
CREATE UNIQUE INDEX "relationships_from_id_to_id_type_key" ON "relationships"("from_id", "to_id", "type");

-- CreateIndex
CREATE INDEX "relationships_from_id_idx" ON "relationships"("from_id");

-- CreateIndex
CREATE INDEX "relationships_to_id_idx" ON "relationships"("to_id");

-- CreateIndex
CREATE INDEX "relationships_type_idx" ON "relationships"("type");

-- CreateIndex
CREATE INDEX "relationships_from_id_type_idx" ON "relationships"("from_id", "type");

-- CreateIndex
CREATE INDEX "relationships_to_id_type_idx" ON "relationships"("to_id", "type");

-- CreateIndex
CREATE INDEX "vector_embeddings_sync_status_last_sync_attempt_idx" ON "vector_embeddings"("sync_status", "last_sync_attempt");

-- CreateIndex
CREATE INDEX "sessions_user_id_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "sessions_platform_type_idx" ON "sessions"("platform_type");

-- CreateIndex
CREATE INDEX "sessions_user_id_ended_at_idx" ON "sessions"("user_id", "ended_at") WHERE "ended_at" IS NULL;

-- CreateIndex
CREATE INDEX "sync_logs_user_id_idx" ON "sync_logs"("user_id");

-- CreateIndex
CREATE INDEX "sync_logs_event_type_idx" ON "sync_logs"("event_type");

-- CreateIndex
CREATE INDEX "sync_logs_started_at_idx" ON "sync_logs"("started_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_organization_id_idx" ON "audit_logs"("organization_id");

-- CreateIndex
CREATE INDEX "audit_logs_event_type_idx" ON "audit_logs"("event_type");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at" DESC);

-- CreateIndex
CREATE INDEX "audit_logs_resource_type_resource_id_idx" ON "audit_logs"("resource_type", "resource_id");

-- CreateIndex
CREATE INDEX "audit_logs_action_idx" ON "audit_logs"("action");

-- CreateIndex
CREATE INDEX "data_export_requests_user_id_idx" ON "data_export_requests"("user_id");

-- CreateIndex
CREATE INDEX "data_export_requests_status_idx" ON "data_export_requests"("status");

-- AddForeignKey
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_organizations" ADD CONSTRAINT "user_organizations_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "platform_integrations" ADD CONSTRAINT "platform_integrations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_org_id_fkey" FOREIGN KEY ("org_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "memories" ADD CONSTRAINT "memories_supersedes_id_fkey" FOREIGN KEY ("supersedes_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "relationships" ADD CONSTRAINT "relationships_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "vector_embeddings" ADD CONSTRAINT "vector_embeddings_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sync_logs" ADD CONSTRAINT "sync_logs_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_resource_id_fkey" FOREIGN KEY ("resource_id") REFERENCES "memories"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "data_export_requests" ADD CONSTRAINT "data_export_requests_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

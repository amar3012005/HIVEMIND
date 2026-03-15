# Phase 1 Implementation Specification: Backend Engineer

**Document Version:** 1.0.0  
**Role:** Backend Engineer  
**Estimated Duration:** 10-14 days  
**Priority:** Critical (Foundation Layer)  
**Compliance Reference:** CROSS_PLATFORM_SYNC_SPEC.md §2  

---

## Executive Summary

This specification defines the backend implementation for HIVE-MIND's cross-platform context preservation system. You will build a **PostgreSQL 15 + Apache AGE** database layer with **Prisma ORM**, integrate **ZITADEL OIDC** authentication, and implement RESTful APIs for memory management and cross-platform sync.

### Key Deliverables

1. ✅ PostgreSQL 15 schema with Apache AGE graph extensions
2. ✅ Prisma ORM schema with multi-tenant isolation
3. ✅ ZITADEL OIDC integration (Node.js/TypeScript)
4. ✅ REST API endpoints (`/api/memories`, `/api/recall`, `/api/sync`)
5. ✅ Migration scripts from in-memory to PostgreSQL
6. ✅ Connection pooling, indexes, query optimization

---

## 1. Environment Setup

### 1.1 Prerequisites

```bash
# Required software
Node.js >= 20.x
PostgreSQL 15.x
Docker & Docker Compose
Prisma CLI >= 5.x

# Install PostgreSQL 15 (macOS)
brew install postgresql@15
brew services start postgresql@15

# Install Prisma CLI
npm install -g prisma
```

### 1.2 Project Structure

```
core/
├── src/
│   ├── db/
│   │   ├── schema.sql          # Raw SQL schema (Apache AGE)
│   │   ├── seed.ts             # Database seeding
│   │   └── migrations/         # Prisma migrations
│   ├── auth/
│   │   ├── zitadel.ts          # OIDC client
│   │   ├── middleware.ts       # JWT validation
│   │   └── rbac.ts             # Role-based access control
│   ├── api/
│   │   ├── routes/
│   │   │   ├── memories.ts     # Memory CRUD
│   │   │   ├── recall.ts       # Semantic search
│   │   │   └── sync.ts         # Cross-platform sync
│   │   ├── middleware/
│   │   │   ├── auth.ts         # Authentication
│   │   │   ├── rateLimit.ts    # Rate limiting
│   │   │   └── logging.ts      # Request logging
│   │   └── validators/
│   │       └── schemas.ts      # Zod validation schemas
│   ├── services/
│   │   ├── memory.service.ts   # Business logic
│   │   ├── vector.service.ts   # Qdrant integration
│   │   └── sync.service.ts     # Sync orchestration
│   └── utils/
│       ├── encryption.ts       # LUKS2/HYOK helpers
│       └── logger.ts           # Structured logging
├── prisma/
│   ├── schema.prisma           # Prisma schema
│   └── migrations/             # Auto-generated migrations
├── tests/
│   ├── integration/
│   └── e2e/
└── docker-compose.dev.yml      # Local development stack
```

---

## 2. PostgreSQL 15 + Apache AGE Schema

### 2.1 Full DDL with Encryption Annotations

```sql
-- ==========================================
-- File: core/src/db/schema.sql
-- HIVE-MIND Cross-Platform Schema
-- PostgreSQL 15+ with Apache AGE extension
-- EU Sovereign: LUKS2 encryption, HYOK
-- ==========================================

-- Enable required extensions
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "age";

LOAD 'age';
SET search_path = ag_catalog, "$user", public;

-- ==========================================
-- ENCRYPTION FUNCTIONS (HYOK Pattern)
-- ==========================================

-- Create encryption key management schema
CREATE SCHEMA IF NOT EXISTS encryption;

-- Function to encrypt sensitive data with HSM-backed key
CREATE OR REPLACE FUNCTION encryption.encrypt_with_hsm(
    plaintext TEXT,
    key_id UUID,
    key_version INTEGER DEFAULT 1
) RETURNS TEXT AS $$
DECLARE
    encrypted_data TEXT;
    key_material BYTEA;
BEGIN
    -- In production: Fetch key from OVHcloud HSM via KMIP
    -- For development: Use pgcrypto with derived key
    key_material := pgp_sym_encrypt(key_id::TEXT || ':' || key_version::TEXT, current_setting('app.hsm_master_key', TRUE));
    
    encrypted_data := pgp_sym_encrypt(plaintext, key_material::TEXT);
    
    -- Log encryption event for audit
    INSERT INTO encryption.audit_log (operation, key_id, key_version, created_at)
    VALUES ('encrypt', key_id, key_version, CURRENT_TIMESTAMP);
    
    RETURN encrypted_data;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Function to decrypt sensitive data
CREATE OR REPLACE FUNCTION encryption.decrypt_with_hsm(
    ciphertext TEXT,
    key_id UUID,
    key_version INTEGER DEFAULT 1
) RETURNS TEXT AS $$
DECLARE
    decrypted_data TEXT;
    key_material BYTEA;
BEGIN
    key_material := pgp_sym_encrypt(key_id::TEXT || ':' || key_version::TEXT, current_setting('app.hsm_master_key', TRUE));
    
    decrypted_data := pgp_sym_decrypt(ciphertext, key_material::TEXT);
    
    -- Log decryption event for audit
    INSERT INTO encryption.audit_log (operation, key_id, key_version, created_at)
    VALUES ('decrypt', key_id, key_version, CURRENT_TIMESTAMP);
    
    RETURN decrypted_data;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- Audit log for encryption operations
CREATE TABLE encryption.audit_log (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    operation VARCHAR(20) NOT NULL,
    key_id UUID NOT NULL,
    key_version INTEGER NOT NULL,
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_encryption_audit_key ON encryption.audit_log(key_id);
CREATE INDEX idx_encryption_audit_time ON encryption.audit_log(created_at DESC);

-- ==========================================
-- USERS & ORGANIZATIONS (Multi-tenant)
-- ==========================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    zitadel_user_id VARCHAR(255) UNIQUE NOT NULL,
    email VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    avatar_url TEXT,
    timezone VARCHAR(50) DEFAULT 'UTC',
    locale VARCHAR(10) DEFAULT 'en',

    -- HYOK encryption keys
    encryption_key_id UUID NOT NULL DEFAULT uuid_generate_v4(),
    encryption_key_version INTEGER DEFAULT 1,

    -- Metadata
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,

    CONSTRAINT chk_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    zitadel_org_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,

    -- Compliance
    data_residency_region VARCHAR(50) DEFAULT 'eu-central',
    compliance_flags TEXT[] DEFAULT ARRAY['GDPR', 'NIS2', 'DORA'],

    -- HYOK configuration
    hsm_provider VARCHAR(50) DEFAULT 'ovhcloud',
    hsm_key_arn VARCHAR(255),

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_organizations (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member',
    invited_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    joined_at TIMESTAMPTZ,

    PRIMARY KEY (user_id, org_id)
);

-- ==========================================
-- PLATFORM INTEGRATIONS
-- ==========================================

CREATE TABLE platform_integrations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,

    -- Platform identification
    platform_type VARCHAR(50) NOT NULL,
    platform_user_id VARCHAR(255),
    platform_display_name VARCHAR(255),

    -- Authentication (encrypted fields)
    auth_type VARCHAR(50) NOT NULL,
    access_token_encrypted TEXT,
    refresh_token_encrypted TEXT,
    token_expires_at TIMESTAMPTZ,
    api_key_hash VARCHAR(255),
    webhook_secret_encrypted TEXT,

    -- OAuth metadata
    oauth_scopes TEXT[],
    oauth_granted_at TIMESTAMPTZ,
    oauth_last_refreshed TIMESTAMPTZ,

    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMPTZ,
    sync_status VARCHAR(50) DEFAULT 'idle',

    -- Error tracking
    last_error_message TEXT,
    last_error_at TIMESTAMPTZ,
    consecutive_failures INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(user_id, platform_type)
);

CREATE INDEX idx_platform_integrations_user ON platform_integrations(user_id);
CREATE INDEX idx_platform_integrations_type ON platform_integrations(platform_type);
CREATE INDEX idx_platform_integrations_status ON platform_integrations(is_active, sync_status);

-- ==========================================
-- MEMORIES (Core table with triple-operator support)
-- ==========================================

CREATE TYPE memory_type AS ENUM ('fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship');
CREATE TYPE relationship_type AS ENUM ('Updates', 'Extends', 'Derives');
CREATE TYPE visibility_scope AS ENUM ('private', 'organization', 'public');

CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,

    -- Content
    content TEXT NOT NULL,
    memory_type memory_type DEFAULT 'fact',
    title VARCHAR(500),
    tags TEXT[],

    -- Source tracking (cross-platform)
    source_platform VARCHAR(50),
    source_session_id VARCHAR(255),
    source_message_id VARCHAR(255),
    source_url TEXT,

    -- Triple-operator relationships
    is_latest BOOLEAN DEFAULT TRUE,
    supersedes_id UUID REFERENCES memories(id),

    -- Cognitive scoring
    strength REAL DEFAULT 1.0,
    recall_count INTEGER DEFAULT 0,
    importance_score REAL DEFAULT 0.5,
    last_confirmed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    -- Temporal grounding
    document_date TIMESTAMPTZ,
    event_dates TIMESTAMPTZ[],

    -- Visibility & sharing
    visibility visibility_scope DEFAULT 'private',
    shared_with_orgs UUID[],

    -- Vector search metadata
    embedding_model VARCHAR(100) DEFAULT 'mistral-embed',
    embedding_dimension INTEGER DEFAULT 1024,
    embedding_version INTEGER DEFAULT 1,

    -- Compliance
    processing_basis VARCHAR(100) DEFAULT 'consent',
    retention_until TIMESTAMPTZ,
    export_blocked BOOLEAN DEFAULT FALSE,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ
);

-- Performance indexes
CREATE INDEX idx_memories_user ON memories(user_id);
CREATE INDEX idx_memories_org ON memories(org_id);
CREATE INDEX idx_memories_type ON memories(memory_type);
CREATE INDEX idx_memories_latest ON memories(is_latest) WHERE is_latest = TRUE;
CREATE INDEX idx_memories_source ON memories(source_platform);
CREATE INDEX idx_memories_document_date ON memories(document_date DESC);
CREATE INDEX idx_memories_strength ON memories(strength DESC);
CREATE INDEX idx_memories_deleted ON memories(deleted_at) WHERE deleted_at IS NOT NULL;

-- Full-text search index
CREATE INDEX idx_memories_content_fts ON memories USING GIN (to_tsvector('english', content));

-- ==========================================
-- RELATIONSHIPS (Graph edges)
-- ==========================================

CREATE TABLE relationships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    from_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    to_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    type relationship_type NOT NULL,

    confidence REAL DEFAULT 1.0,
    inference_model VARCHAR(100),
    inference_prompt_hash VARCHAR(64),

    metadata JSONB DEFAULT '{}',
    created_by VARCHAR(50) DEFAULT 'system',

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,

    UNIQUE(from_id, to_id, type)
);

CREATE INDEX idx_relationships_from ON relationships(from_id);
CREATE INDEX idx_relationships_to ON relationships(to_id);
CREATE INDEX idx_relationships_type ON relationships(type);
CREATE INDEX idx_relationships_from_type ON relationships(from_id, type);
CREATE INDEX idx_relationships_to_type ON relationships(to_id, type);

-- ==========================================
-- VECTOR EMBEDDINGS (Qdrant sync metadata)
-- ==========================================

CREATE TABLE vector_embeddings (
    memory_id UUID PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    qdrant_collection VARCHAR(100) NOT NULL,
    qdrant_point_id UUID NOT NULL,

    embedding_version INTEGER DEFAULT 1,
    last_reembedded_at TIMESTAMPTZ,

    sync_status VARCHAR(50) DEFAULT 'synced',
    last_sync_attempt TIMESTAMPTZ,
    sync_error_message TEXT,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_vector_embeddings_sync ON vector_embeddings(sync_status, last_sync_attempt);

-- ==========================================
-- SESSIONS (Cross-platform session tracking)
-- ==========================================

CREATE TABLE sessions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,

    platform_type VARCHAR(50) NOT NULL,
    platform_session_id VARCHAR(255),

    title VARCHAR(500),
    message_count INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,

    memories_injected UUID[],
    context_window_used INTEGER DEFAULT 0,
    compaction_triggered BOOLEAN DEFAULT FALSE,

    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_activity_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    end_reason VARCHAR(50),

    auto_captured_count INTEGER DEFAULT 0,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_platform ON sessions(platform_type);
CREATE INDEX idx_sessions_active ON sessions(user_id, ended_at) WHERE ended_at IS NULL;

-- ==========================================
-- SYNC LOGS (Audit trail)
-- ==========================================

CREATE TABLE sync_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,

    event_type VARCHAR(50) NOT NULL,
    source_platform VARCHAR(50),
    target_platform VARCHAR(50),

    memory_ids UUID[],
    session_id UUID REFERENCES sessions(id),
    payload_hash VARCHAR(64),

    status VARCHAR(50) DEFAULT 'success',
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,

    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    latency_ms INTEGER
);

CREATE INDEX idx_sync_logs_user ON sync_logs(user_id);
CREATE INDEX idx_sync_logs_event ON sync_logs(event_type);
CREATE INDEX idx_sync_logs_time ON sync_logs(started_at DESC);

-- ==========================================
-- APACHE AGE GRAPH
-- ==========================================

SELECT create_graph('hivemind_memory_graph');

-- ==========================================
-- VIEWS
-- ==========================================

CREATE VIEW active_memories AS
SELECT
    m.*,
    u.email as user_email,
    o.name as org_name,
    o.data_residency_region
FROM memories m
JOIN users u ON m.user_id = u.id
LEFT JOIN organizations o ON m.org_id = o.id
WHERE m.is_latest = TRUE
  AND m.deleted_at IS NULL
  AND (m.retention_until IS NULL OR m.retention_until > CURRENT_TIMESTAMP);

CREATE VIEW user_platform_sync_status AS
SELECT
    u.id as user_id,
    u.email,
    pi.platform_type,
    pi.is_active,
    pi.sync_status,
    pi.last_synced_at,
    pi.consecutive_failures,
    CASE
        WHEN pi.consecutive_failures >= 3 THEN 'critical'
        WHEN pi.consecutive_failures >= 1 THEN 'warning'
        WHEN pi.last_synced_at < CURRENT_TIMESTAMP - INTERVAL '1 hour' THEN 'stale'
        ELSE 'healthy'
    END as health_status
FROM users u
LEFT JOIN platform_integrations pi ON u.id = pi.user_id
WHERE u.deleted_at IS NULL;

-- ==========================================
-- GDPR: DATA EXPORT/ERASURE
-- ==========================================

CREATE TABLE data_export_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    request_type VARCHAR(50) NOT NULL,
    status VARCHAR(50) DEFAULT 'pending',
    export_format VARCHAR(20) DEFAULT 'json',
    export_url TEXT,
    requested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    error_message TEXT
);

-- ==========================================
-- AUDIT LOGGING (NIS2/DORA: 7-year retention)
-- ==========================================

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,

    event_type VARCHAR(100) NOT NULL,
    event_category VARCHAR(50),
    resource_type VARCHAR(50),
    resource_id UUID,

    action VARCHAR(50) NOT NULL,
    old_value JSONB,
    new_value JSONB,

    ip_address INET,
    user_agent TEXT,
    platform_type VARCHAR(50),
    session_id UUID,

    processing_basis VARCHAR(100),
    legal_basis_note TEXT,

    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_event ON audit_logs(event_type);
CREATE INDEX idx_audit_logs_time ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- ==========================================
-- TRIGGERS
-- ==========================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_users_updated_at BEFORE UPDATE ON users
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_organizations_updated_at BEFORE UPDATE ON organizations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_platform_integrations_updated_at BEFORE UPDATE ON platform_integrations
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_memories_updated_at BEFORE UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_vector_embeddings_updated_at BEFORE UPDATE ON vector_embeddings
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
```

---

## 3. Prisma Schema with Multi-Tenant Isolation

### 3.1 Complete Prisma Schema

```prisma
// File: core/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
  previewFeatures = ["multiSchema", "postgresqlExtensions"]
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
  extensions = [age, "uuid-ossp", pgcrypto]
  schemas = ["public", "encryption"]
}

// ==========================================
// MULTI-TENANT MODELS
// ==========================================

model User {
  id                  String   @id @default(uuid()) @map("id") @db.Uuid
  zitadelUserId       String   @unique @map("zitadel_user_id")
  email               String   @unique
  displayName         String?  @map("display_name")
  avatarUrl           String?  @map("avatar_url") @db.Text
  timezone            String   @default("UTC")
  locale              String   @default("en")

  // HYOK encryption
  encryptionKeyId     String   @default(uuid()) @map("encryption_key_id") @db.Uuid
  encryptionKeyVersion Int     @default(1) @map("encryption_key_version")

  // Relations
  organizations       UserOrganization[]
  memories            Memory[]
  platformIntegrations PlatformIntegration[]
  sessions            Session[]
  syncLogs            SyncLog[]
  auditLogs           AuditLog[]

  // Timestamps
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")
  lastActiveAt        DateTime? @map("last_active_at")
  deletedAt           DateTime? @map("deleted_at")

  @@map("users")
}

model Organization {
  id                  String   @id @default(uuid()) @map("id") @db.Uuid
  zitadelOrgId        String   @unique @map("zitadel_org_id")
  name                String
  slug                String   @unique

  // Compliance
  dataResidencyRegion String   @default("eu-central") @map("data_residency_region")
  complianceFlags     String[] @default(["GDPR", "NIS2", "DORA"]) @map("compliance_flags")

  // HYOK
  hsmProvider         String   @default("ovhcloud") @map("hsm_provider")
  hsmKeyArn           String?  @map("hsm_key_arn")

  // Relations
  users               UserOrganization[]
  memories            Memory[]
  auditLogs           AuditLog[]

  // Timestamps
  createdAt           DateTime @default(now()) @map("created_at")
  updatedAt           DateTime @updatedAt @map("updated_at")

  @@map("organizations")
}

model UserOrganization {
  userId    String   @map("user_id") @db.Uuid
  orgId     String   @map("org_id") @db.Uuid
  role      String   @default("member")
  invitedAt DateTime @default(now()) @map("invited_at")
  joinedAt  DateTime? @map("joined_at")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  org  Organization @relation(fields: [orgId], references: [id], onDelete: Cascade)

  @@id([userId, orgId])
  @@map("user_organizations")
}

// ==========================================
// PLATFORM INTEGRATIONS
// ==========================================

enum PlatformType {
  chatgpt
  claude
  perplexity
  gemini
  other
}

enum AuthType {
  oauth2
  api_key
  webhook
}

enum SyncStatus {
  idle
  syncing
  error
  revoked
}

model PlatformIntegration {
  id                    String       @id @default(uuid()) @map("id") @db.Uuid
  userId                String       @map("user_id") @db.Uuid
  platformType          PlatformType @map("platform_type")
  platformUserId        String?      @map("platform_user_id")
  platformDisplayName   String?      @map("platform_display_name")

  // Authentication
  authType              AuthType     @map("auth_type")
  accessTokenEncrypted  String?      @map("access_token_encrypted") @db.Text
  refreshTokenEncrypted String?      @map("refresh_token_encrypted") @db.Text
  tokenExpiresAt        DateTime?    @map("token_expires_at")
  apiKeyHash            String?      @map("api_key_hash")
  webhookSecretEncrypted String?     @map("webhook_secret_encrypted") @db.Text

  // OAuth
  oauthScopes         String[]   @map("oauth_scopes")
  oauthGrantedAt      DateTime?  @map("oauth_granted_at")
  oauthLastRefreshed  DateTime?  @map("oauth_last_refreshed")

  // Status
  isActive            Boolean    @default(true) @map("is_active")
  lastSyncedAt        DateTime?  @map("last_synced_at")
  syncStatus          SyncStatus @default(idle) @map("sync_status")

  // Error tracking
  lastErrorMessage    String?    @map("last_error_message") @db.Text
  lastErrorAt         DateTime?  @map("last_error_at")
  consecutiveFailures Int        @default(0) @map("consecutive_failures")

  // Relations
  user User @relation(fields: [userId], references: [id], onDelete: Cascade)

  // Timestamps
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@unique([userId, platformType])
  @@index([userId])
  @@index([platformType])
  @@index([isActive, syncStatus])
  @@map("platform_integrations")
}

// ==========================================
// MEMORIES
// ==========================================

enum MemoryType {
  fact
  preference
  decision
  lesson
  goal
  event
  relationship
}

enum RelationshipType {
  Updates
  Extends
  Derives
}

enum VisibilityScope {
  private
  organization
  public
}

model Memory {
  id              String        @id @default(uuid()) @map("id") @db.Uuid
  userId          String        @map("user_id") @db.Uuid
  orgId           String?       @map("org_id") @db.Uuid

  // Content
  content         String
  memoryType      MemoryType    @default(fact) @map("memory_type")
  title           String?
  tags            String[]

  // Source tracking
  sourcePlatform  String?       @map("source_platform")
  sourceSessionId String?       @map("source_session_id")
  sourceMessageId String?       @map("source_message_id")
  sourceUrl       String?       @map("source_url") @db.Text

  // Triple-operator
  isLatest        Boolean       @default(true) @map("is_latest")
  supersedesId    String?       @map("supersedes_id") @db.Uuid
  supersedes      Memory?       @relation("MemorySupersedes", fields: [supersedesId], references: [id])
  supersededBy    Memory[]      @relation("MemorySupersedes")

  // Cognitive scoring
  strength        Float         @default(1.0)
  recallCount     Int           @default(0) @map("recall_count")
  importanceScore Float         @default(0.5) @map("importance_score")
  lastConfirmedAt DateTime      @default(now()) @map("last_confirmed_at")

  // Temporal
  documentDate    DateTime?     @map("document_date")
  eventDates      DateTime[]    @map("event_dates")

  // Visibility
  visibility      VisibilityScope @default(private)
  sharedWithOrgs  String[]      @map("shared_with_orgs")

  // Vector metadata
  embeddingModel    String      @default("mistral-embed") @map("embedding_model")
  embeddingDimension Int        @default(1024) @map("embedding_dimension")
  embeddingVersion  Int         @default(1) @map("embedding_version")

  // Compliance
  processingBasis   String      @default("consent") @map("processing_basis")
  retentionUntil    DateTime?   @map("retention_until")
  exportBlocked     Boolean     @default(false) @map("export_blocked")

  // Relations
  user              User              @relation(fields: [userId], references: [id], onDelete: Cascade)
  organization      Organization?     @relation(fields: [orgId], references: [id], onDelete: Cascade)
  relationshipsFrom Relationship[]    @relation("RelationshipFrom")
  relationshipsTo   Relationship[]    @relation("RelationshipTo")
  vectorEmbedding   VectorEmbedding?
  syncLogs          SyncLog[]

  // Timestamps
  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")
  deletedAt DateTime? @map("deleted_at")

  @@index([userId])
  @@index([orgId])
  @@index([memoryType])
  @@index([isLatest])
  @@index([sourcePlatform])
  @@index([documentDate])
  @@index([strength])
  @@map("memories")
}

model Relationship {
  id                  String           @id @default(uuid()) @map("id") @db.Uuid
  fromId              String           @map("from_id") @db.Uuid
  toId                String           @map("to_id") @db.Uuid
  type                RelationshipType

  confidence          Float            @default(1.0)
  inferenceModel      String?          @map("inference_model")
  inferencePromptHash String?          @map("inference_prompt_hash")

  metadata            Json             @default("{}")
  createdBy           String           @default("system") @map("created_by")

  fromMemory Memory @relation("RelationshipFrom", fields: [fromId], references: [id], onDelete: Cascade)
  toMemory   Memory @relation("RelationshipTo", fields: [toId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now()) @map("created_at")

  @@unique([fromId, toId, type])
  @@index([fromId])
  @@index([toId])
  @@index([type])
  @@index([fromId, type])
  @@index([toId, type])
  @@map("relationships")
}

// ==========================================
// VECTOR EMBEDDINGS
// ==========================================

model VectorEmbedding {
  memoryId        String   @id @map("memory_id") @db.Uuid
  qdrantCollection String  @map("qdrant_collection")
  qdrantPointId   String   @map("qdrant_point_id") @db.Uuid

  embeddingVersion Int     @default(1) @map("embedding_version")
  lastReembeddedAt DateTime? @map("last_reembedded_at")

  syncStatus       String   @default("synced") @map("sync_status")
  lastSyncAttempt  DateTime? @map("last_sync_attempt")
  syncErrorMessage String?  @map("sync_error_message") @db.Text

  memory Memory @relation(fields: [memoryId], references: [id], onDelete: Cascade)

  createdAt DateTime @default(now()) @map("created_at")
  updatedAt DateTime @updatedAt @map("updated_at")

  @@index([syncStatus, lastSyncAttempt])
  @@map("vector_embeddings")
}

// ==========================================
// SESSIONS
// ==========================================

model Session {
  id                String     @id @default(uuid()) @map("id") @db.Uuid
  userId            String     @map("user_id") @db.Uuid

  platformType      String     @map("platform_type")
  platformSessionId String?    @map("platform_session_id")

  title             String?
  messageCount      Int        @default(0) @map("message_count")
  tokenCount        Int        @default(0) @map("token_count")

  memoriesInjected  String[]   @map("memories_injected")
  contextWindowUsed Int        @default(0) @map("context_window_used")
  compactionTriggered Boolean  @default(false) @map("compaction_triggered")

  startedAt         DateTime   @default(now()) @map("started_at")
  lastActivityAt    DateTime?  @map("last_activity_at")
  endedAt           DateTime?  @map("ended_at")
  endReason         String?    @map("end_reason")

  autoCapturedCount Int        @default(0) @map("auto_captured_count")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  syncLogs SyncLog[]

  createdAt DateTime @default(now()) @map("created_at")

  @@index([userId])
  @@index([platformType])
  @@index([userId, endedAt])
  @@map("sessions")
}

// ==========================================
// SYNC LOGS
// ==========================================

model SyncLog {
  id            String     @id @default(uuid()) @map("id") @db.Uuid
  userId        String     @map("user_id") @db.Uuid

  eventType     String     @map("event_type")
  sourcePlatform String?   @map("source_platform")
  targetPlatform String?   @map("target_platform")

  memoryIds     String[]   @map("memory_ids")
  sessionId     String?    @map("session_id") @db.Uuid
  payloadHash   String?    @map("payload_hash")

  status        String     @default("success")
  errorMessage  String?    @map("error_message") @db.Text
  retryCount    Int        @default(0) @map("retry_count")

  startedAt     DateTime   @default(now()) @map("started_at")
  completedAt   DateTime?  @map("completed_at")
  latencyMs     Int?       @map("latency_ms")

  user User @relation(fields: [userId], references: [id], onDelete: Cascade)
  session Session? @relation(fields: [sessionId], references: [id])
  memories Memory[]

  @@index([userId])
  @@index([eventType])
  @@index([startedAt])
  @@map("sync_logs")
}

// ==========================================
// DATA EXPORT REQUESTS (GDPR)
// ==========================================

enum RequestType {
  export
  erasure
  portability
}

enum ExportStatus {
  pending
  processing
  completed
  failed
}

model DataExportRequest {
  id           String       @id @default(uuid()) @map("id") @db.Uuid
  userId       String       @map("user_id") @db.Uuid
  requestType  RequestType  @map("request_type")
  status       ExportStatus @default(pending)
  exportFormat String       @default("json") @map("export_format")
  exportUrl    String?      @map("export_url") @db.Text

  requestedAt  DateTime     @default(now()) @map("requested_at")
  completedAt  DateTime?    @map("completed_at")
  errorMessage String?      @map("error_message") @db.Text

  @@map("data_export_requests")
}

// ==========================================
// AUDIT LOGS (NIS2/DORA)
// ==========================================

model AuditLog {
  id              String   @id @default(uuid()) @map("id") @db.Uuid
  userId          String?  @map("user_id") @db.Uuid
  organizationId  String?  @map("organization_id") @db.Uuid

  eventType       String   @map("event_type")
  eventCategory   String?  @map("event_category")
  resourceType    String?  @map("resource_type")
  resourceId      String?  @map("resource_id") @db.Uuid

  action          String
  oldValue        Json?    @map("old_value")
  newValue        Json?    @map("new_value")

  ipAddress       String?  @map("ip_address") @db.Inet
  userAgent       String?  @map("user_agent") @db.Text
  platformType    String?  @map("platform_type")
  sessionId       String?  @map("session_id") @db.Uuid

  processingBasis String?  @map("processing_basis")
  legalBasisNote  String?  @map("legal_basis_note") @db.Text

  createdAt       DateTime @default(now()) @map("created_at")

  @@index([userId])
  @@index([organizationId])
  @@index([eventType])
  @@index([createdAt])
  @@index([resourceType, resourceId])
  @@map("audit_logs")
}
```

---

## 4. ZITADEL OIDC Integration

### 4.1 OIDC Client Implementation

```typescript
// File: core/src/auth/zitadel.ts

import { Issuer, BaseClient, TokenSet } from 'openid-client';
import { z } from 'zod';
import { logger } from '../utils/logger';

// Configuration schema
const ZitadelConfigSchema = z.object({
  issuerUrl: z.string().url(),
  clientId: z.string(),
  clientSecret: z.string(),
  redirectUri: z.string().url(),
  postLogoutRedirectUri: z.string().url(),
  scope: z.string().default('openid profile email offline_access'),
});

export type ZitadelConfig = z.infer<typeof ZitadelConfigSchema>;

export class ZitadelClient {
  private client: BaseClient;
  private config: ZitadelConfig;

  constructor(config: ZitadelConfig) {
    this.config = ZitadelConfigSchema.parse(config);
    this.client = null as unknown as BaseClient;
  }

  /**
   * Initialize the OIDC client by discovering issuer configuration
   */
  async initialize(): Promise<void> {
    try {
      const issuer = await Issuer.discover(this.config.issuerUrl);
      
      this.client = new issuer.Client({
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
        redirect_uris: [this.config.redirectUri],
        post_logout_redirect_uris: [this.config.postLogoutRedirectUri],
        response_types: ['code'],
        grant_types: ['authorization_code', 'refresh_token'],
      });

      logger.info('ZITADEL OIDC client initialized', {
        issuer: this.config.issuerUrl,
        clientId: this.config.clientId,
      });
    } catch (error) {
      logger.error('Failed to initialize ZITADEL client', { error });
      throw new Error(`ZITADEL initialization failed: ${error}`);
    }
  }

  /**
   * Generate authorization URL for login flow
   */
  generateAuthUrl(state: string, organizationId?: string): string {
    const params = new URLSearchParams({
      state,
      scope: this.config.scope,
    });

    if (organizationId) {
      params.append('organization', organizationId);
    }

    return this.client.authorizationUrl(params);
  }

  /**
   * Exchange authorization code for tokens
   */
  async exchangeCode(code: string, state: string): Promise<TokenSet> {
    try {
      const tokenSet = await this.client.callback(
        this.config.redirectUri,
        { code, state },
        { state }
      );

      logger.info('Token exchange successful', {
        hasIdToken: !!tokenSet.id_token,
        hasAccessToken: !!tokenSet.access_token,
        expiresAt: tokenSet.expires_at,
      });

      return tokenSet;
    } catch (error) {
      logger.error('Token exchange failed', { error, state });
      throw new Error(`Token exchange failed: ${error}`);
    }
  }

  /**
   * Refresh access token using refresh token
   */
  async refreshTokens(refreshToken: string): Promise<TokenSet> {
    try {
      const tokenSet = await this.client.refresh(refreshToken);

      logger.info('Token refresh successful', {
        expiresAt: tokenSet.expires_at,
      });

      return tokenSet;
    } catch (error) {
      logger.error('Token refresh failed', { error });
      throw new Error(`Token refresh failed: ${error}`);
    }
  }

  /**
   * Get user info from token
   */
  async getUserInfo(accessToken: string): Promise<ZitadelUserInfo> {
    try {
      const userinfo = await this.client.userinfo(accessToken);
      
      return {
        sub: userinfo.sub,
        email: userinfo.email,
        name: userinfo.name,
        givenName: userinfo.given_name,
        familyName: userinfo.family_name,
        picture: userinfo.picture,
        emailVerified: userinfo.email_verified ?? false,
        locale: userinfo.locale,
        updatedAt: userinfo.updated_at,
      };
    } catch (error) {
      logger.error('Failed to get user info', { error });
      throw new Error(`User info fetch failed: ${error}`);
    }
  }

  /**
   * Validate and decode ID token
   */
  async validateIdToken(idToken: string): Promise<ZitadelIdTokenPayload> {
    try {
      const tokenSet = new TokenSet({ id_token: idToken });
      const claims = tokenSet.claims();

      // Verify issuer
      if (claims.iss !== this.config.issuerUrl) {
        throw new Error('Invalid issuer');
      }

      return {
        sub: claims.sub,
        email: claims.email,
        name: claims.name,
        givenName: claims.given_name,
        familyName: claims.family_name,
        picture: claims.picture,
        emailVerified: claims.email_verified ?? false,
        locale: claims.locale,
        organizationId: claims.org_id,
        organizationName: claims.org_name,
        roles: claims.roles ?? [],
        iat: claims.iat,
        exp: claims.exp,
        iss: claims.iss,
        aud: claims.aud,
      };
    } catch (error) {
      logger.error('ID token validation failed', { error });
      throw new Error(`ID token validation failed: ${error}`);
    }
  }

  /**
   * Revoke tokens (logout)
   */
  async revokeTokens(token: string, typeHint: 'access_token' | 'refresh_token' = 'access_token'): Promise<void> {
    try {
      await this.client.revoke(token, typeHint);
      logger.info('Token revoked', { typeHint });
    } catch (error) {
      logger.error('Token revocation failed', { error });
      throw new Error(`Token revocation failed: ${error}`);
    }
  }

  /**
   * Get JWKS for token verification
   */
  async getJwks(): Promise<any> {
    return this.client.issuer.jwks;
  }
}

// Type definitions
export interface ZitadelUserInfo {
  sub: string;
  email: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  emailVerified: boolean;
  locale?: string;
  updatedAt?: number;
}

export interface ZitadelIdTokenPayload {
  sub: string;
  email: string;
  name?: string;
  givenName?: string;
  familyName?: string;
  picture?: string;
  emailVerified: boolean;
  locale?: string;
  organizationId?: string;
  organizationName?: string;
  roles?: string[];
  iat: number;
  exp: number;
  iss: string;
  aud: string | string[];
}

// Singleton instance
let zitadelClient: ZitadelClient | null = null;

export function getZitadelClient(): ZitadelClient {
  if (!zitadelClient) {
    zitadelClient = new ZitadelClient({
      issuerUrl: process.env.ZITADEL_ISSUER_URL!,
      clientId: process.env.ZITADEL_CLIENT_ID!,
      clientSecret: process.env.ZITADEL_CLIENT_SECRET!,
      redirectUri: process.env.ZITADEL_REDIRECT_URI!,
      postLogoutRedirectUri: process.env.ZITADEL_POST_LOGOUT_REDIRECT_URI!,
    });
  }
  return zitadelClient;
}
```

### 4.2 JWT Validation Middleware

```typescript
// File: core/src/auth/middleware.ts

import { Request, Response, NextFunction } from 'express';
import jwt, { JwtPayload, JsonWebTokenError, TokenExpiredError } from 'jsonwebtoken';
import { getZitadelClient, ZitadelIdTokenPayload } from './zitadel';
import { logger } from '../utils/logger';

// Extend Express Request type
declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
    }
  }
}

export interface AuthenticatedUser {
  id: string;
  email: string;
  name?: string;
  organizationId?: string;
  organizationName?: string;
  roles: string[];
  zitadelUserId: string;
}

/**
 * Middleware to validate JWT tokens from ZITADEL
 */
export async function authenticateJWT(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({
      error: 'Unauthorized',
      message: 'Missing or invalid Authorization header',
    });
    return;
  }

  const token = authHeader.substring(7); // Remove 'Bearer ' prefix

  try {
    // Get ZITADEL client and JWKS
    const zitadelClient = getZitadelClient();
    const jwks = await zitadelClient.getJwks();

    // Verify token with JWKS
    const decoded = jwt.verify(token, jwks, {
      algorithms: ['RS256'],
      issuer: process.env.ZITADEL_ISSUER_URL,
      audience: process.env.ZITADEL_CLIENT_ID,
    }) as JwtPayload & ZitadelIdTokenPayload;

    // Attach user to request
    req.user = {
      id: decoded.sub,
      email: decoded.email,
      name: decoded.name,
      organizationId: decoded.organizationId,
      organizationName: decoded.organizationName,
      roles: decoded.roles ?? [],
      zitadelUserId: decoded.sub,
    };

    logger.debug('JWT authenticated', {
      userId: req.user.id,
      email: req.user.email,
      organizationId: req.user.organizationId,
    });

    next();
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      res.status(401).json({
        error: 'Token expired',
        message: 'Please re-authenticate',
      });
      return;
    }

    if (error instanceof JsonWebTokenError) {
      res.status(401).json({
        error: 'Invalid token',
        message: 'Token verification failed',
      });
      return;
    }

    logger.error('JWT authentication failed', { error });
    res.status(500).json({
      error: 'Authentication error',
      message: 'Internal authentication error',
    });
  }
}

/**
 * Middleware to require specific roles
 */
export function requireRoles(...requiredRoles: string[]) {
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.user) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'Authentication required',
      });
      return;
    }

    const userRoles = req.user.roles ?? [];
    const hasRequiredRole = requiredRoles.some(role => userRoles.includes(role));

    if (!hasRequiredRole) {
      logger.warning('Access denied: insufficient roles', {
        userId: req.user.id,
        userRoles,
        requiredRoles,
      });

      res.status(403).json({
        error: 'Forbidden',
        message: 'Insufficient permissions',
        required: requiredRoles,
      });
      return;
    }

    next();
  };
}

/**
 * Middleware to require organization membership
 */
export function requireOrganization(req: Request, res: Response, next: NextFunction): void {
  if (!req.user?.organizationId) {
    res.status(403).json({
      error: 'Forbidden',
      message: 'Organization context required',
    });
    return;
  }

  next();
}

/**
 * Optional authentication - attaches user if token is valid, continues otherwise
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    next();
    return;
  }

  const token = authHeader.substring(7);

  try {
    const zitadelClient = getZitadelClient();
    const jwks = await zitadelClient.getJwks();

    const decoded = jwt.verify(token, jwks, {
      algorithms: ['RS256'],
      issuer: process.env.ZITADEL_ISSUER_URL,
      audience: process.env.ZITADEL_CLIENT_ID,
    }) as JwtPayload & ZitadelIdTokenPayload;

    req.user = {
      id: decoded.sub,
      email: decoded.email,
      name: decoded.name,
      organizationId: decoded.organizationId,
      organizationName: decoded.organizationName,
      roles: decoded.roles ?? [],
      zitadelUserId: decoded.sub,
    };
  } catch (error) {
    // Silently fail - authentication is optional
    logger.debug('Optional auth failed', { error });
  }

  next();
}
```

---

## 5. API Endpoint Implementations

### 5.1 Memory CRUD Endpoints

```typescript
// File: core/src/api/routes/memories.ts

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authenticateJWT, requireRoles } from '../../auth/middleware';
import { logger } from '../../utils/logger';
import { getVectorService } from '../../services/vector.service';
import { auditLog } from '../../services/audit.service';

const router = Router();
const prisma = new PrismaClient();

// Request validation schemas
const CreateMemorySchema = z.object({
  content: z.string().min(1).max(10000),
  memoryType: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']).optional(),
  title: z.string().max(500).optional(),
  tags: z.array(z.string()).optional(),
  sourcePlatform: z.string().optional(),
  sourceSessionId: z.string().optional(),
  sourceMessageId: z.string().optional(),
  importanceScore: z.number().min(0).max(1).optional(),
  visibility: z.enum(['private', 'organization', 'public']).optional(),
  documentDate: z.string().datetime().optional(),
  eventDates: z.array(z.string().datetime()).optional(),
});

const UpdateMemorySchema = z.object({
  content: z.string().min(1).max(10000).optional(),
  title: z.string().max(500).optional(),
  tags: z.array(z.string()).optional(),
  importanceScore: z.number().min(0).max(1).optional(),
  visibility: z.enum(['private', 'organization', 'public']).optional(),
});

const QuerySchema = z.object({
  limit: z.coerce.number().min(1).max(100).default(20),
  offset: z.coerce.number().min(0).default(0),
  memoryType: z.string().optional(),
  sourcePlatform: z.string().optional(),
  tags: z.string().optional(), // comma-separated
  sortBy: z.enum(['createdAt', 'documentDate', 'strength', 'importanceScore']).default('createdAt'),
  sortOrder: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * POST /api/memories
 * Create a new memory with vector embedding
 */
router.post('/', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();

  try {
    // Validate request body
    const body = CreateMemorySchema.parse(req.body);
    const userId = req.user!.id;

    logger.info('Creating memory', {
      requestId,
      userId,
      memoryType: body.memoryType,
      sourcePlatform: body.sourcePlatform,
    });

    // Generate vector embedding
    const vectorService = getVectorService();
    const embedding = await vectorService.generateEmbedding(body.content);

    // Create memory in database
    const memory = await prisma.memory.create({
      data: {
        userId,
        content: body.content,
        memoryType: body.memoryType ?? 'fact',
        title: body.title,
        tags: body.tags ?? [],
        sourcePlatform: body.sourcePlatform,
        sourceSessionId: body.sourceSessionId,
        sourceMessageId: body.sourceMessageId,
        importanceScore: body.importanceScore ?? 0.5,
        visibility: body.visibility ?? 'private',
        documentDate: body.documentDate ? new Date(body.documentDate) : new Date(),
        eventDates: body.eventDates?.map(d => new Date(d)) ?? [],
      },
    });

    // Store vector embedding in Qdrant
    await vectorService.upsertPoint({
      collection: 'hivemind_memories',
      id: memory.id,
      vector: embedding,
      payload: {
        user_id: userId,
        memory_id: memory.id,
        content: body.content,
        memory_type: memory.memoryType,
        tags: memory.tags,
        source_platform: memory.sourcePlatform,
        document_date: memory.documentDate,
        importance_score: memory.importanceScore,
      },
    });

    // Create vector embedding record
    await prisma.vectorEmbedding.create({
      data: {
        memoryId: memory.id,
        qdrantCollection: 'hivemind_memories',
        qdrantPointId: memory.id,
        syncStatus: 'synced',
      },
    });

    // Audit log
    await auditLog({
      userId,
      eventType: 'memory_created',
      eventCategory: 'data_modification',
      resourceType: 'memory',
      resourceId: memory.id,
      action: 'create',
      newValue: { content: body.content, memoryType: memory.memoryType },
      platformType: body.sourcePlatform,
    });

    logger.info('Memory created successfully', {
      requestId,
      memoryId: memory.id,
    });

    res.status(201).json({
      id: memory.id,
      content: memory.content,
      memoryType: memory.memoryType,
      title: memory.title,
      tags: memory.tags,
      createdAt: memory.createdAt,
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    logger.error('Failed to create memory', { requestId, error });
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  }
});

/**
 * GET /api/memories
 * List memories with filtering and pagination
 */
router.get('/', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();

  try {
    const query = QuerySchema.parse(req.query);
    const userId = req.user!.id;

    logger.debug('Listing memories', {
      requestId,
      userId,
      limit: query.limit,
      offset: query.offset,
    });

    // Build filter conditions
    const where: any = {
      userId,
      isLatest: true,
      deletedAt: null,
    };

    if (query.memoryType) {
      where.memoryType = query.memoryType;
    }

    if (query.sourcePlatform) {
      where.sourcePlatform = query.sourcePlatform;
    }

    if (query.tags) {
      const tags = query.tags.split(',');
      where.tags = { hasSome: tags };
    }

    // Build sort order
    const orderBy: any = {};
    orderBy[query.sortBy] = query.sortOrder;

    // Fetch memories
    const [memories, total] = await Promise.all([
      prisma.memory.findMany({
        where,
        orderBy,
        skip: query.offset,
        take: query.limit,
        select: {
          id: true,
          content: true,
          memoryType: true,
          title: true,
          tags: true,
          sourcePlatform: true,
          importanceScore: true,
          strength: true,
          documentDate: true,
          createdAt: true,
          updatedAt: true,
        },
      }),
      prisma.memory.count({ where }),
    ]);

    logger.info('Memories listed', {
      requestId,
      count: memories.length,
      total,
    });

    res.json({
      data: memories,
      pagination: {
        limit: query.limit,
        offset: query.offset,
        total,
        hasMore: query.offset + memories.length < total,
      },
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    logger.error('Failed to list memories', { requestId, error });
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  }
});

/**
 * GET /api/memories/:id
 * Get a specific memory by ID
 */
router.get('/:id', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const memory = await prisma.memory.findFirst({
      where: {
        id,
        userId,
        deletedAt: null,
      },
      include: {
        relationshipsFrom: {
          select: {
            type: true,
            toMemory: {
              select: {
                id: true,
                title: true,
                memoryType: true,
              },
            },
          },
        },
        relationshipsTo: {
          select: {
            type: true,
            fromMemory: {
              select: {
                id: true,
                title: true,
                memoryType: true,
              },
            },
          },
        },
      },
    });

    if (!memory) {
      res.status(404).json({
        error: 'Not found',
        message: 'Memory not found',
      });
      return;
    }

    // Audit log
    await auditLog({
      userId,
      eventType: 'memory_read',
      eventCategory: 'data_access',
      resourceType: 'memory',
      resourceId: id,
      action: 'read',
    });

    logger.debug('Memory retrieved', { requestId, memoryId: id });

    res.json({
      id: memory.id,
      content: memory.content,
      memoryType: memory.memoryType,
      title: memory.title,
      tags: memory.tags,
      sourcePlatform: memory.sourcePlatform,
      importanceScore: memory.importanceScore,
      strength: memory.strength,
      recallCount: memory.recallCount,
      documentDate: memory.documentDate,
      eventDates: memory.eventDates,
      relationships: {
        from: memory.relationshipsFrom.map(r => ({
          type: r.type,
          to: { id: r.toMemory.id, title: r.toMemory.title, memoryType: r.toMemory.memoryType },
        })),
        to: memory.relationshipsTo.map(r => ({
          type: r.type,
          from: { id: r.fromMemory.id, title: r.fromMemory.title, memoryType: r.fromMemory.memoryType },
        })),
      },
      createdAt: memory.createdAt,
      updatedAt: memory.updatedAt,
    });

  } catch (error) {
    logger.error('Failed to get memory', { requestId, error });
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  }
});

/**
 * PATCH /api/memories/:id
 * Update a memory (creates new version with Updates relationship)
 */
router.patch('/:id', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const body = UpdateMemorySchema.parse(req.body);

    // Get existing memory
    const existingMemory = await prisma.memory.findFirst({
      where: { id, userId, deletedAt: null },
    });

    if (!existingMemory) {
      res.status(404).json({
        error: 'Not found',
        message: 'Memory not found',
      });
      return;
    }

    // Start transaction for versioning
    const [updatedMemory] = await prisma.$transaction(async (tx) => {
      // Mark old memory as not latest
      await tx.memory.update({
        where: { id },
        data: { isLatest: false },
      });

      // Create new version
      const newMemory = await tx.memory.create({
        data: {
          userId,
          content: body.content ?? existingMemory.content,
          memoryType: existingMemory.memoryType,
          title: body.title ?? existingMemory.title,
          tags: body.tags ?? existingMemory.tags,
          importanceScore: body.importanceScore ?? existingMemory.importanceScore,
          visibility: body.visibility ?? existingMemory.visibility,
          supersedesId: id,
          documentDate: existingMemory.documentDate,
          eventDates: existingMemory.eventDates,
        },
      });

      // Update vector embedding
      if (body.content) {
        const vectorService = getVectorService();
        const embedding = await vectorService.generateEmbedding(body.content);

        await vectorService.upsertPoint({
          collection: 'hivemind_memories',
          id: newMemory.id,
          vector: embedding,
          payload: {
            user_id: userId,
            memory_id: newMemory.id,
            content: body.content,
          },
        });
      }

      return [newMemory];
    });

    // Audit log
    await auditLog({
      userId,
      eventType: 'memory_updated',
      eventCategory: 'data_modification',
      resourceType: 'memory',
      resourceId: id,
      action: 'update',
      oldValue: { content: existingMemory.content },
      newValue: { content: body.content ?? existingMemory.content },
    });

    logger.info('Memory updated', { requestId, memoryId: id, newVersionId: updatedMemory.id });

    res.json({
      id: updatedMemory.id,
      content: updatedMemory.content,
      supersedesId: id,
      updatedAt: updatedMemory.updatedAt,
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    logger.error('Failed to update memory', { requestId, error });
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  }
});

/**
 * DELETE /api/memories/:id
 * Soft delete a memory
 */
router.delete('/:id', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();
  const { id } = req.params;
  const userId = req.user!.id;

  try {
    const memory = await prisma.memory.findFirst({
      where: { id, userId },
    });

    if (!memory) {
      res.status(404).json({
        error: 'Not found',
        message: 'Memory not found',
      });
      return;
    }

    // Soft delete
    await prisma.memory.update({
      where: { id },
      data: { deletedAt: new Date() },
    });

    // Mark vector embedding for deletion
    await prisma.vectorEmbedding.update({
      where: { memoryId: id },
      data: { syncStatus: 'pending_delete' },
    });

    // Audit log
    await auditLog({
      userId,
      eventType: 'memory_deleted',
      eventCategory: 'data_modification',
      resourceType: 'memory',
      resourceId: id,
      action: 'delete',
    });

    logger.info('Memory deleted', { requestId, memoryId: id });

    res.status(204).send();

  } catch (error) {
    logger.error('Failed to delete memory', { requestId, error });
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  }
});

export default router;
```

### 5.2 Recall (Semantic Search) Endpoint

```typescript
// File: core/src/api/routes/recall.ts

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authenticateJWT, optionalAuth } from '../../auth/middleware';
import { logger } from '../../utils/logger';
import { getVectorService } from '../../services/vector.service';
import { calculateRecallScore } from '../../services/recall.service';

const router = Router();
const prisma = new PrismaClient();

// Request schema
const RecallQuerySchema = z.object({
  query: z.string().min(1).max(2000),
  limit: z.coerce.number().min(1).max(50).default(10),
  memoryTypes: z.string().optional(), // comma-separated
  sourcePlatform: z.string().optional(),
  minImportance: z.coerce.number().min(0).max(1).optional(),
  includeFullText: z.coerce.boolean().default(false),
  recencyBias: z.coerce.number().min(0).max(1).default(0.5), // 0 = no bias, 1 = strong bias
});

/**
 * POST /api/recall
 * Semantic search with hybrid scoring (vector + recency + importance)
 */
router.post('/', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();

  try {
    const body = RecallQuerySchema.parse(req.body);
    const userId = req.user!.id;

    logger.info('Recall query', {
      requestId,
      userId,
      queryLength: body.query.length,
      limit: body.limit,
      recencyBias: body.recencyBias,
    });

    // Generate query embedding
    const vectorService = getVectorService();
    const queryEmbedding = await vectorService.generateEmbedding(body.query);

    // Search Qdrant with filters
    const vectorResults = await vectorService.search({
      collection: 'hivemind_memories',
      vector: queryEmbedding,
      limit: body.limit * 2, // Get more for re-ranking
      filter: {
        must: [
          { key: 'user_id', match: { value: userId } },
        ],
      },
    });

    // Extract memory IDs
    const memoryIds = vectorResults.map(r => r.payload.memory_id);

    if (memoryIds.length === 0) {
      logger.info('No memories found', { requestId });
      res.json({ results: [], metadata: { total: 0, latencyMs: 0 } });
      return;
    }

    // Fetch full memory data from PostgreSQL
    const memories = await prisma.memory.findMany({
      where: {
        id: { in: memoryIds },
        userId,
        isLatest: true,
        deletedAt: null,
      },
    });

    // Apply additional filters
    let filteredMemories = memories;

    if (body.memoryTypes) {
      const types = body.memoryTypes.split(',');
      filteredMemories = filteredMemories.filter(m => types.includes(m.memoryType));
    }

    if (body.sourcePlatform) {
      filteredMemories = filteredMemories.filter(m => m.sourcePlatform === body.sourcePlatform);
    }

    if (body.minImportance !== undefined) {
      filteredMemories = filteredMemories.filter(m => m.importanceScore >= body.minImportance);
    }

    // Calculate recall scores with recency bias
    const scoredMemories = filteredMemories.map(memory => {
      const vectorResult = vectorResults.find(r => r.payload.memory_id === memory.id);
      const vectorScore = vectorResult?.score ?? 0;

      const recallScore = calculateRecallScore({
        vectorScore,
        importanceScore: memory.importanceScore,
        strength: memory.strength,
        documentDate: memory.documentDate,
        recallCount: memory.recallCount,
        recencyBias: body.recencyBias,
      });

      return {
        memory,
        score: recallScore,
        vectorScore,
      };
    });

    // Sort by recall score and limit
    scoredMemories.sort((a, b) => b.score - a.score);
    const topMemories = scoredMemories.slice(0, body.limit);

    // Format response
    const results = topMemories.map(({ memory, score, vectorScore }) => ({
      id: memory.id,
      content: memory.content,
      memoryType: memory.memoryType,
      title: memory.title,
      tags: memory.tags,
      sourcePlatform: memory.sourcePlatform,
      documentDate: memory.documentDate,
      importanceScore: memory.importanceScore,
      scores: {
        recall: score,
        vector: vectorScore,
      },
    }));

    logger.info('Recall completed', {
      requestId,
      resultsCount: results.length,
    });

    res.json({
      results,
      metadata: {
        query: body.query,
        total: results.length,
        latencyMs: Date.now(),
      },
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    logger.error('Recall failed', { requestId, error });
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  }
});

/**
 * GET /api/recall/context
 * Get context for current session (used by AI platforms)
 */
router.get('/context', optionalAuth, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();

  try {
    // For optional auth, we might use API key or session token
    const userId = req.user?.id ?? req.headers['x-user-id'] as string;

    if (!userId) {
      res.status(401).json({
        error: 'Unauthorized',
        message: 'User identification required',
      });
      return;
    }

    // Get recent memories for context injection
    const memories = await prisma.memory.findMany({
      where: {
        userId,
        isLatest: true,
        deletedAt: null,
        visibility: 'private',
      },
      orderBy: { documentDate: 'desc' },
      take: 20,
      select: {
        id: true,
        content: true,
        memoryType: true,
        title: true,
        tags: true,
        documentDate: true,
      },
    });

    // Format as XML for LLM consumption
    const contextXml = memories.map(m => `
  <memory id="${m.id}" type="${m.memoryType}">
    <title>${m.title ?? 'Untitled'}</title>
    <content>${m.content}</content>
    <tags>${m.tags?.join(', ') ?? ''}</tags>
    <date>${m.documentDate?.toISOString() ?? ''}</date>
  </memory>
`).join('');

    const fullContext = `
<relevant-memories user-id="${userId}">
${contextXml}
</relevant-memories>`;

    logger.debug('Context retrieved', { requestId, userId, memoryCount: memories.length });

    res.setHeader('Content-Type', 'application/xml');
    res.send(fullContext);

  } catch (error) {
    logger.error('Context retrieval failed', { requestId, error });
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  }
});

export default router;
```

### 5.3 Cross-Platform Sync Endpoint

```typescript
// File: core/src/api/routes/sync.ts

import { Router, Request, Response } from 'express';
import { PrismaClient } from '@prisma/client';
import { z } from 'zod';
import { authenticateJWT } from '../../auth/middleware';
import { logger } from '../../utils/logger';
import { getSyncService } from '../../services/sync.service';

const router = Router();
const prisma = new PrismaClient();

// Request schemas
const SyncMemoriesSchema = z.object({
  memories: z.array(z.object({
    id: z.string().uuid().optional(),
    content: z.string().min(1).max(10000),
    memoryType: z.enum(['fact', 'preference', 'decision', 'lesson', 'goal', 'event', 'relationship']),
    title: z.string().max(500).optional(),
    tags: z.array(z.string()).optional(),
    sourcePlatform: z.string(),
    sourceSessionId: z.string().optional(),
    sourceMessageId: z.string().optional(),
    documentDate: z.string().datetime().optional(),
  })),
});

const SyncStatusSchema = z.object({
  platformType: z.string().optional(),
});

/**
 * POST /api/sync/memories
 * Batch sync memories from a platform
 */
router.post('/memories', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();
  const userId = req.user!.id;

  try {
    const body = SyncMemoriesSchema.parse(req.body);
    const sourcePlatform = body.memories[0]?.sourcePlatform;

    logger.info('Batch sync started', {
      requestId,
      userId,
      sourcePlatform,
      memoryCount: body.memories.length,
    });

    const syncService = getSyncService();
    const results = await syncService.batchSyncMemories({
      userId,
      memories: body.memories,
      sourcePlatform,
    });

    // Log sync event
    await prisma.syncLog.create({
      data: {
        userId,
        eventType: 'memory_batch_synced',
        sourcePlatform,
        memoryIds: results.map(r => r.id),
        status: results.every(r => r.success) ? 'success' : 'partial',
        completedAt: new Date(),
        latencyMs: Date.now(),
      },
    });

    logger.info('Batch sync completed', {
      requestId,
      successCount: results.filter(r => r.success).length,
      failureCount: results.filter(r => !r.success).length,
    });

    res.json({
      results: results.map(r => ({
        id: r.id,
        success: r.success,
        error: r.error,
      })),
      metadata: {
        total: body.memories.length,
        success: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length,
      },
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    logger.error('Batch sync failed', { requestId, error });
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  }
});

/**
 * GET /api/sync/status
 * Get sync status for all platforms
 */
router.get('/status', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();
  const userId = req.user!.id;

  try {
    const integrations = await prisma.platformIntegration.findMany({
      where: { userId, isActive: true },
      select: {
        platformType: true,
        syncStatus: true,
        lastSyncedAt: true,
        consecutiveFailures: true,
        lastErrorMessage: true,
      },
    });

    const status = integrations.map(i => ({
      platform: i.platformType,
      status: i.syncStatus,
      lastSyncedAt: i.lastSyncedAt,
      health: i.consecutiveFailures >= 3 ? 'critical' : i.consecutiveFailures >= 1 ? 'warning' : 'healthy',
      lastError: i.lastErrorMessage,
    }));

    logger.debug('Sync status retrieved', { requestId, userId, platformCount: status.length });

    res.json({ platforms: status });

  } catch (error) {
    logger.error('Sync status failed', { requestId, error });
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  }
});

/**
 * POST /api/sync/trigger
 * Manually trigger sync for a platform
 */
router.post('/trigger', authenticateJWT, async (req: Request, res: Response): Promise<void> => {
  const requestId = crypto.randomUUID();
  const userId = req.user!.id;

  try {
    const body = SyncStatusSchema.parse(req.body);

    const syncService = getSyncService();
    await syncService.triggerPlatformSync({
      userId,
      platformType: body.platformType,
    });

    logger.info('Sync triggered', { requestId, userId, platformType: body.platformType });

    res.json({
      status: 'triggered',
      platformType: body.platformType,
    });

  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        error: 'Validation error',
        details: error.errors,
      });
      return;
    }

    logger.error('Sync trigger failed', { requestId, error });
    res.status(500).json({
      error: 'Internal server error',
      requestId,
    });
  }
});

export default router;
```

---

## 6. Migration Scripts

### 6.1 In-Memory to PostgreSQL Migration

```typescript
// File: core/src/db/migrate-from-memory.ts

import { PrismaClient } from '@prisma/client';
import { readFileSync, writeFileSync } from 'fs';
import { logger } from '../utils/logger';
import { getVectorService } from '../services/vector.service';

interface LegacyMemory {
  id: string;
  content: string;
  type: string;
  tags: string[];
  createdAt: string;
  metadata?: {
    source?: string;
    importance?: number;
  };
}

interface MigrationReport {
  total: number;
  migrated: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
  durationMs: number;
}

/**
 * Migrate memories from in-memory JSON to PostgreSQL
 */
export async function migrateFromMemory(
  inputPath: string,
  userId: string,
  options: {
    batchSize?: number;
    dryRun?: boolean;
    skipEmbeddings?: boolean;
  } = {}
): Promise<MigrationReport> {
  const prisma = new PrismaClient();
  const startTime = Date.now();

  const report: MigrationReport = {
    total: 0,
    migrated: 0,
    failed: 0,
    errors: [],
    durationMs: 0,
  };

  try {
    // Read legacy data
    const legacyData = readFileSync(inputPath, 'utf-8');
    const memories: LegacyMemory[] = JSON.parse(legacyData);
    report.total = memories.length;

    logger.info('Starting migration', {
      totalMemories: memories.length,
      userId,
      dryRun: options.dryRun,
    });

    if (options.dryRun) {
      logger.info('DRY RUN - No changes will be made');
      report.migrated = memories.length;
      report.durationMs = Date.now() - startTime;
      return report;
    }

    const batchSize = options.batchSize ?? 50;
    const vectorService = getVectorService();

    // Process in batches
    for (let i = 0; i < memories.length; i += batchSize) {
      const batch = memories.slice(i, i + batchSize);
      logger.info('Processing batch', { batchNumber: Math.floor(i / batchSize) + 1 });

      for (const memory of batch) {
        try {
          // Generate embedding if not skipped
          let embedding: number[] | undefined;
          if (!options.skipEmbeddings) {
            embedding = await vectorService.generateEmbedding(memory.content);
          }

          // Create memory in PostgreSQL
          const created = await prisma.memory.create({
            data: {
              userId,
              content: memory.content,
              memoryType: memory.type as any ?? 'fact',
              tags: memory.tags,
              sourcePlatform: memory.metadata?.source,
              importanceScore: memory.metadata?.importance ?? 0.5,
              documentDate: new Date(memory.createdAt),
            },
          });

          // Store embedding in Qdrant
          if (embedding) {
            await vectorService.upsertPoint({
              collection: 'hivemind_memories',
              id: created.id,
              vector: embedding,
              payload: {
                user_id: userId,
                memory_id: created.id,
                content: memory.content,
              },
            });

            await prisma.vectorEmbedding.create({
              data: {
                memoryId: created.id,
                qdrantCollection: 'hivemind_memories',
                qdrantPointId: created.id,
              },
            });
          }

          report.migrated++;

        } catch (error) {
          report.failed++;
          report.errors.push({
            id: memory.id,
            error: String(error),
          });
          logger.error('Migration failed for memory', { memoryId: memory.id, error });
        }
      }
    }

    report.durationMs = Date.now() - startTime;

    logger.info('Migration completed', {
      total: report.total,
      migrated: report.migrated,
      failed: report.failed,
      durationMs: report.durationMs,
    });

    // Write migration report
    writeFileSync(
      `migration-report-${Date.now()}.json`,
      JSON.stringify(report, null, 2)
    );

    return report;

  } catch (error) {
    logger.error('Migration failed', { error });
    throw error;
  } finally {
    await prisma.$disconnect();
  }
}

// CLI usage
if (require.main === module) {
  const inputPath = process.argv[2];
  const userId = process.argv[3];
  const dryRun = process.argv.includes('--dry-run');
  const skipEmbeddings = process.argv.includes('--skip-embeddings');

  if (!inputPath || !userId) {
    console.error('Usage: ts-node migrate-from-memory.ts <input.json> <user-id> [--dry-run] [--skip-embeddings]');
    process.exit(1);
  }

  migrateFromMemory(inputPath, userId, { dryRun, skipEmbeddings })
    .then(report => {
      console.log('Migration Report:', JSON.stringify(report, null, 2));
      process.exit(report.failed > 0 ? 1 : 0);
    })
    .catch(error => {
      console.error('Migration failed:', error);
      process.exit(1);
    });
}
```

---

## 7. Connection Pooling & Query Optimization

### 7.1 Database Connection Configuration

```typescript
// File: core/src/db/connection.ts

import { PrismaClient } from '@prisma/client';
import { logger } from '../utils/logger';

// Connection pool configuration
const POOL_CONFIG = {
  // Maximum number of connections in pool
  max: parseInt(process.env.DB_POOL_MAX ?? '20'),
  
  // Minimum number of connections in pool
  min: parseInt(process.env.DB_POOL_MIN ?? '5'),
  
  // Time to wait before timing out on connection acquisition
  connectionTimeoutMillis: parseInt(process.env.DB_CONNECTION_TIMEOUT ?? '30000'),
  
  // Time to wait before idle connections are released
  idleTimeoutMillis: parseInt(process.env.DB_IDLE_TIMEOUT ?? '60000'),
  
  // Maximum time a connection can be used before being recycled
  maxLifetimeMillis: parseInt(process.env.DB_MAX_LIFETIME ?? '1800000'),
};

// Prisma client with connection pool settings
const prisma = new PrismaClient({
  datasources: {
    db: {
      url: process.env.DATABASE_URL,
    },
  },
  log: [
    { level: 'query', emit: 'event' },
    { level: 'error', emit: 'event' },
    { level: 'warn', emit: 'event' },
  ],
});

// Query logging for performance monitoring
prisma.$on('query', (e) => {
  const duration = e.duration;
  
  // Log slow queries
  if (duration > 1000) {
    logger.warning('Slow query detected', {
      duration,
      query: e.query,
      params: e.params,
    });
  } else {
    logger.debug('Query executed', { duration, query: e.query });
  }
});

prisma.$on('error', (e) => {
  logger.error('Database error', { error: e.message, target: e.target });
});

// Health check function
export async function checkDatabaseHealth(): Promise<boolean> {
  try {
    await prisma.$queryRaw`SELECT 1`;
    return true;
  } catch (error) {
    logger.error('Database health check failed', { error });
    return false;
  }
}

// Graceful shutdown
export async function disconnectDatabase(): Promise<void> {
  await prisma.$disconnect();
  logger.info('Database connections closed');
}

export { prisma };
```

### 7.2 Query Optimization Strategies

```typescript
// File: core/src/db/optimized-queries.ts

import { prisma } from './connection';
import { logger } from '../utils/logger';

/**
 * Optimized memory retrieval with selective columns
 */
export async function getMemoriesOptimized(
  userId: string,
  options: {
    limit: number;
    offset: number;
    memoryType?: string;
    includeRelationships?: boolean;
  }
) {
  const { limit, offset, memoryType, includeRelationships } = options;

  // Use select to limit columns fetched
  const select: any = {
    id: true,
    content: true,
    memoryType: true,
    title: true,
    tags: true,
    importanceScore: true,
    documentDate: true,
    createdAt: true,
  };

  if (includeRelationships) {
    select.relationshipsFrom = {
      select: {
        type: true,
        toMemory: { select: { id: true, title: true } },
      },
    };
  }

  const where: any = {
    userId,
    isLatest: true,
    deletedAt: null,
  };

  if (memoryType) {
    where.memoryType = memoryType;
  }

  // Use raw query for complex pagination with count
  const [memories, total] = await Promise.all([
    prisma.memory.findMany({
      where,
      select,
      orderBy: { documentDate: 'desc' },
      skip: offset,
      take: limit,
    }),
    prisma.memory.count({ where }),
  ]);

  return { memories, total };
}

/**
 * Batch memory retrieval to avoid N+1 queries
 */
export async function getMemoriesBatch(memoryIds: string[]) {
  if (memoryIds.length === 0) return [];

  // Use findMany with IN clause instead of individual queries
  const memories = await prisma.memory.findMany({
    where: {
      id: { in: memoryIds },
      deletedAt: null,
    },
  });

  // Create map for O(1) lookup
  const memoryMap = new Map(memories.map(m => [m.id, m]));

  return memoryMap;
}

/**
 * Efficient graph traversal using raw SQL
 */
export async function getRelatedMemories(
  memoryId: string,
  maxDepth: number = 2
) {
  // Use Apache AGE Cypher for graph traversal
  const result = await prisma.$queryRaw`
    SELECT * FROM cypher('hivemind_memory_graph', $$
      MATCH (m:Memory {id: ${memoryId}})-[:Derives|Extends|Updates*1..${maxDepth}]-(related:Memory)
      WHERE related.is_latest = true AND related.deleted_at IS NULL
      RETURN related.id, related.content, related.memory_type, 
             relationships(m, related).type as relationship_type
    $$) AS (id uuid, content text, memory_type text, relationship_type text)
  `;

  return result;
}

/**
 * Materialized view refresh for active memories
 */
export async function refreshActiveMemoriesView() {
  const startTime = Date.now();

  await prisma.$executeRaw`REFRESH MATERIALIZED VIEW CONCURRENTLY active_memories`;

  logger.info('Active memories view refreshed', {
    durationMs: Date.now() - startTime,
  });
}

/**
 * Index usage analysis
 */
export async function analyzeIndexUsage(tableName: string) {
  const result = await prisma.$queryRaw`
    SELECT
      schemaname,
      tablename,
      indexname,
      idx_scan,
      idx_tup_read,
      idx_tup_fetch
    FROM pg_stat_user_indexes
    WHERE tablename = ${tableName}
    ORDER BY idx_scan DESC
  `;

  return result;
}
```

---

## 8. Acceptance Criteria

### 8.1 Functional Requirements

| ID | Requirement | Test Method | Pass Criteria |
|----|-------------|-------------|---------------|
| BE-01 | PostgreSQL schema deployed with all tables | Run `psql -c "\dt"` | All 12+ tables exist |
| BE-02 | Apache AGE extension enabled | Run `SELECT * FROM ag_graph;` | Graph 'hivemind_memory_graph' exists |
| BE-03 | Prisma client generates without errors | Run `npx prisma generate` | Exit code 0 |
| BE-04 | ZITADEL OIDC login flow works | Manual login test | User redirected and authenticated |
| BE-05 | JWT validation middleware rejects invalid tokens | Send request with fake JWT | 401 response |
| BE-06 | POST /api/memories creates memory + embedding | Integration test | Memory in DB + Qdrant point |
| BE-07 | POST /api/recall returns relevant memories | Integration test | Results sorted by recall score |
| BE-08 | Migration script migrates 1000+ memories | Run migration script | <1% failure rate |
| BE-09 | Connection pool handles 100 concurrent requests | Load test (k6) | P99 latency <500ms |
| BE-10 | Slow queries (>1s) are logged | Check logs during load test | All slow queries logged |

### 8.2 Performance Requirements

| Metric | Target | Measurement |
|--------|--------|-------------|
| Memory creation latency | P99 <200ms | Excluding embedding generation |
| Recall query latency | P99 <300ms | Including vector search |
| Database connection time | <50ms | Time to acquire connection |
| Migration throughput | >100 memories/sec | During batch migration |

### 8.3 Security Requirements

| ID | Requirement | Verification |
|----|-------------|--------------|
| SEC-01 | All tokens encrypted at rest | Check `access_token_encrypted` field |
| SEC-02 | SQL injection prevented | Use parameterized queries only |
| SEC-03 | Audit logs capture all mutations | Verify audit_logs table |
| SEC-04 | Multi-tenant isolation enforced | Test cross-user access attempts |

---

## 9. Testing Instructions

### 9.1 Unit Tests

```bash
# Run unit tests
npm run test:unit

# With coverage
npm run test:unit -- --coverage
```

### 9.2 Integration Tests

```bash
# Start test database
docker-compose -f docker-compose.test.yml up -d

# Run integration tests
npm run test:integration

# Run specific test file
npm run test:integration -- memories.test.ts
```

### 9.3 Load Testing

```bash
# Install k6
brew install k6

# Run load test
k6 run tests/load/memory-api.js

# Stress test (1000 concurrent users)
k6 run --vus 1000 --duration 5m tests/load/memory-api.js
```

### 9.4 Migration Test

```bash
# Dry run migration
ts-node src/db/migrate-from-memory.ts test-data.json test-user-id --dry-run

# Actual migration
ts-node src/db/migrate-from-memory.ts test-data.json test-user-id

# Verify results
psql -c "SELECT COUNT(*) FROM memories WHERE user_id = 'test-user-id'"
```

---

## 10. Environment Variables

```bash
# Database
DATABASE_URL="postgresql://user:password@localhost:5432/hivemind?schema=public"
DB_POOL_MAX=20
DB_POOL_MIN=5
DB_CONNECTION_TIMEOUT=30000
DB_IDLE_TIMEOUT=60000
DB_MAX_LIFETIME=1800000

# ZITADEL
ZITADEL_ISSUER_URL="https://auth.hivemind.io"
ZITADEL_CLIENT_ID="your-client-id"
ZITADEL_CLIENT_SECRET="your-client-secret"
ZITADEL_REDIRECT_URI="https://api.hivemind.io/auth/callback"
ZITADEL_POST_LOGOUT_REDIRECT_URI="https://hivemind.io"

# Encryption (HYOK)
HSM_MASTER_KEY="your-master-key-from-vault"
ENCRYPTION_ALGORITHM="aes-256-gcm"

# Qdrant
QDRANT_URL="http://localhost:6333"
QDRANT_API_KEY="your-qdrant-api-key"

# Redis (for sync)
REDIS_URL="redis://localhost:6379"

# Logging
LOG_LEVEL="info"
LOG_FORMAT="json"
```

---

## 11. Deployment Checklist

- [ ] PostgreSQL 15 installed with Apache AGE extension
- [ ] Database schema applied (`psql -f schema.sql`)
- [ ] Prisma migrations run (`npx prisma migrate deploy`)
- [ ] ZITADEL application configured
- [ ] Environment variables set in production
- [ ] Connection pool tested under load
- [ ] All API endpoints tested
- [ ] Migration script validated with production data subset
- [ ] Monitoring dashboards configured
- [ ] Backup procedures tested

---

## 12. References

- [CROSS_PLATFORM_SYNC_SPEC.md](../CROSS_PLATFORM_SYNC_SPEC.md) - Main specification
- [PostgreSQL 15 Documentation](https://www.postgresql.org/docs/15/)
- [Apache AGE Documentation](https://age.apache.org/)
- [Prisma ORM Documentation](https://www.prisma.io/docs)
- [ZITADEL OIDC Documentation](https://zitadel.com/docs)
- [EU Data Sovereignty Guidelines](https://digital-strategy.ec.europa.eu/en/policies/data-strategy)

---

**Document Approval:**

| Role | Name | Date | Signature |
|------|------|------|-----------|
| Backend Lead | | | |
| Security Engineer | | | |
| DevOps Engineer | | | |

# HIVE-MIND Cross-Platform Context Preservation System
## Technical Specification v1.0

**Document Status:** Production-Ready  
**Target Platform:** B2C SaaS (Superhuman Competitor)  
**Compliance:** GDPR, NIS2, DORA, EU Data Sovereignty  
**Date:** March 9, 2026

---

## Executive Summary

This specification defines the architecture for a **cross-platform context preservation system** that enables user memories, preferences, and conversation history to persist seamlessly across ChatGPT, Claude, and other AI platforms. The system transforms HIVE-MIND from a single-instance memory engine into a **universal context layer** for the AI ecosystem.

### Key Differentiators vs. Competitors

| Feature | HIVE-MIND | Supermemory | Native Platform Memory |
|---------|-----------|-------------|------------------------|
| **Cross-Platform Sync** | ✅ Real-time | ⚠️ Limited | ❌ Walled Garden |
| **EU Data Sovereignty** | ✅ Full (Hetzner/Scaleway/OVHcloud) | ❌ US Cloud Act | ❌ US Cloud Act |
| **User Data Ownership** | ✅ HYOK Encryption | ⚠️ Platform-Controlled | ❌ Platform-Owned |
| **Portable Context** | ✅ MCP + Export API | ⚠️ Proprietary | ❌ Locked |
| **Latency (P99)** | <300ms | <500ms | N/A |

---

## 1. System Architecture

### 1.1 High-Level Architecture Diagram

```mermaid
C4Context
    title HIVE-MIND Cross-Platform Context Sync Architecture

    Person(user, "End User", "Uses multiple AI platforms (ChatGPT, Claude, etc.)")
    
    System_Boundary(platforms, "AI Platforms") {
        System(chatgpt, "ChatGPT", "OpenAI's conversational AI\n[Custom GPT Actions]")
        System(claude, "Claude", "Anthropic's AI assistant\n[Actions API]")
        System(other, "Other Platforms", "Perplexity, Gemini, etc.\n[Webhooks/APIs]")
    }

    System_Boundary(hivemind, "HIVE-MIND Platform (EU Sovereign)") {
        System(gateway, "API Gateway", "Traefik + Rate Limiting\n[TLS 1.3, EU-only certs]")
        
        Container_Boundary(core, "Core Services") {
            Container(auth, "Auth Service", "ZITADEL + JWT\n[OIDC, SAML, Passkeys]")
            Container(sync, "Sync Engine", "Real-time context sync\n[WebSocket, Redis Pub/Sub]")
            Container(memory, "Memory Engine", "Graph-based storage\n[PostgreSQL + Apache AGE]")
            Container(vector, "Vector Service", "Semantic search\n[Qdrant]")
        }

        Container_Boundary(integration, "Platform Integrations") {
            Container(chatgpt_adapter, "ChatGPT Adapter", "Custom GPT Actions\n[OAuth 2.0]")
            Container(claude_adapter, "Claude Adapter", "Actions API\n[API Key Auth]")
            Container(webhook_mgr, "Webhook Manager", "Platform event ingestion\n[HMAC verification]")
        }

        SystemDb(postgres, "PostgreSQL + AGE", "Primary data store\n[LUKS2 encryption, HYOK]")
        SystemDb(qdrant, "Qdrant", "Vector embeddings\n[Filtered search, tenant isolation]")
        SystemDb(redis, "Redis", "Session state + pub/sub\n[Redis Cloud EU]")
    }

    System_Boundary(infra, "EU Sovereign Infrastructure") {
        System(hetzner, "Hetzner (DE/FI)", "Compute nodes\n[AMD EPYC, NVMe]")
        System(scaleway, "Scaleway (FR)", "Managed PostgreSQL\n[LUKS encryption]")
        System(ovh, "OVHcloud (FR)", "Managed HSM\n[SecNumCloud qualified]")
    }

    Rel(user, chatgpt, "Converses with", "HTTPS")
    Rel(user, claude, "Converses with", "HTTPS")
    Rel(user, other, "Converses with", "HTTPS")
    
    Rel(chatgpt, chatgpt_adapter, "Calls Actions API", "OAuth 2.0 + HTTPS")
    Rel(claude, claude_adapter, "Calls Actions API", "API Key + HTTPS")
    Rel(other, webhook_mgr, "Sends webhooks", "HMAC-signed HTTPS")
    
    Rel(chatgpt_adapter, gateway, "Routes through", "mTLS")
    Rel(claude_adapter, gateway, "Routes through", "mTLS")
    Rel(webhook_mgr, gateway, "Routes through", "mTLS")
    
    Rel(gateway, auth, "Validates tokens", "JWT/OIDC")
    Rel(gateway, sync, "Forwards requests", "Internal API")
    Rel(sync, memory, "Reads/writes memories", "SQL + Graph queries")
    Rel(sync, vector, "Semantic search", "gRPC")
    Rel(sync, redis, "Session state", "Redis protocol")
    
    Rel(memory, postgres, "Persists to", "SQL")
    Rel(vector, qdrant, "Stores embeddings", "gRPC")
    Rel(postgres, ovh, "HSM-backed encryption", "HYOK")
    
    UpdateRelStyle(user, chatgpt, $offsetY="-40")
    UpdateRelStyle(user, claude, $offsetY="0")
    UpdateRelStyle(user, other, $offsetY="40")
```

### 1.2 Data Flow: Cross-Platform Context Sync

```mermaid
sequenceDiagram
    participant U as User
    participant CP as ChatGPT
    participant CA as Claude
    participant HM as HIVE-MIND
    participant DB as PostgreSQL
    participant Q as Qdrant
    participant R as Redis

    Note over U,CP: Session 1: ChatGPT
    U->>CP: "Remember I'm using TypeScript for the backend"
    CP->>HM: POST /api/memories (via Custom GPT Action)
    HM->>HM: Validate OAuth token (ZITADEL)
    HM->>Q: Generate embedding (Mistral-embed)
    HM->>DB: INSERT memory + relationships
    HM->>R: PUBLISH context_updated:user_id
    HM-->>CP: 201 Created {memory_id}
    CP-->>U: "I've saved that context"

    Note over U,CA: Session 2: Claude (different platform)
    U->>CA: "What backend language am I using?"
    CA->>HM: POST /api/recall (via Actions API)
    HM->>HM: Validate API key
    HM->>R: SUBSCRIBE context_updated:user_id (real-time)
    HM->>DB: Query latest memories (graph traversal)
    HM->>Q: Hybrid search (vector + keywords)
    HM-->>CA: {memories: ["TypeScript for backend"]}
    CA-->>U: "You mentioned using TypeScript for the backend"

    Note over HM,DB: Context persists across platforms
```

### 1.3 Component Responsibilities

| Component | Technology | Responsibility | SLA |
|-----------|------------|----------------|-----|
| **API Gateway** | Traefik v3.0 | TLS termination, rate limiting, mTLS | 99.9% |
| **Auth Service** | ZITADEL | OIDC, SAML, passkeys, audit trail | 99.95% |
| **Sync Engine** | Node.js + Redis | Real-time sync, conflict resolution | 99.9% |
| **Memory Engine** | PostgreSQL + Apache AGE | Graph storage, triple-operator logic | 99.99% |
| **Vector Service** | Qdrant | Filtered semantic search | P99 <300ms |
| **ChatGPT Adapter** | Custom GPT Actions | OAuth 2.0 flow, action routing | 99.9% |
| **Claude Adapter** | Actions API | API key auth, webhook handling | 99.9% |
| **Webhook Manager** | Node.js + HMAC | Event ingestion, signature verification | 99.9% |

---

## 2. Database Schema (PostgreSQL)

### 2.1 Core Tables

```sql
-- ==========================================
-- HIVE-MIND Cross-Platform Schema
-- PostgreSQL 15+ with Apache AGE extension
-- EU Sovereign: LUKS2 encryption, HYOK
-- ==========================================

-- Enable Apache AGE extension
CREATE EXTENSION IF NOT EXISTS age;
LOAD 'age';
SET search_path = ag_catalog, "$user", public;

-- ==========================================
-- USERS & ORGANIZATIONS (Multi-tenant)
-- ==========================================

CREATE TABLE users (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zitadel_user_id VARCHAR(255) UNIQUE NOT NULL,  -- External IAM reference
    email VARCHAR(255) UNIQUE NOT NULL,
    display_name VARCHAR(255),
    avatar_url TEXT,
    timezone VARCHAR(50) DEFAULT 'UTC',
    locale VARCHAR(10) DEFAULT 'en',
    
    -- Encryption keys (HYOK pattern)
    encryption_key_id UUID,  -- References OVHcloud HSM
    encryption_key_version INTEGER DEFAULT 1,
    
    -- Metadata
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_active_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,  -- Soft delete for GDPR
    
    CONSTRAINT chk_email_format CHECK (email ~* '^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$')
);

CREATE TABLE organizations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    zitadel_org_id VARCHAR(255) UNIQUE NOT NULL,
    name VARCHAR(255) NOT NULL,
    slug VARCHAR(100) UNIQUE NOT NULL,
    
    -- Compliance
    data_residency_region VARCHAR(50) DEFAULT 'eu-central',  -- eu-central, eu-west
    compliance_flags TEXT[],  -- ['GDPR', 'NIS2', 'DORA', 'HIPAA']
    
    -- HYOK configuration
    hsm_provider VARCHAR(50),  -- 'ovhcloud', 'thales', 'aws-cloudhsm'
    hsm_key_arn VARCHAR(255),
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE user_organizations (
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    role VARCHAR(50) NOT NULL DEFAULT 'member',  -- owner, admin, member, viewer
    invited_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    joined_at TIMESTAMPTZ,
    
    PRIMARY KEY (user_id, org_id)
);

-- ==========================================
-- PLATFORM INTEGRATIONS
-- ==========================================

CREATE TABLE platform_integrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Platform identification
    platform_type VARCHAR(50) NOT NULL,  -- 'chatgpt', 'claude', 'perplexity', 'gemini'
    platform_user_id VARCHAR(255),  -- External platform's user ID
    platform_display_name VARCHAR(255),
    
    -- Authentication
    auth_type VARCHAR(50) NOT NULL,  -- 'oauth2', 'api_key', 'webhook'
    access_token_encrypted TEXT,  -- LUKS2 encrypted
    refresh_token_encrypted TEXT,
    token_expires_at TIMESTAMPTZ,
    api_key_hash VARCHAR(255),  -- SHA-256 hash for verification
    webhook_secret_encrypted TEXT,
    
    -- OAuth metadata
    oauth_scopes TEXT[],
    oauth_granted_at TIMESTAMPTZ,
    oauth_last_refreshed TIMESTAMPTZ,
    
    -- Status
    is_active BOOLEAN DEFAULT TRUE,
    last_synced_at TIMESTAMPTZ,
    sync_status VARCHAR(50) DEFAULT 'idle',  -- idle, syncing, error, revoked
    
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
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
    
    -- Content
    content TEXT NOT NULL,
    memory_type memory_type DEFAULT 'fact',
    title VARCHAR(500),  -- Auto-generated summary
    tags TEXT[],  -- User-defined tags
    
    -- Source tracking (cross-platform)
    source_platform VARCHAR(50),  -- 'chatgpt', 'claude', etc.
    source_session_id VARCHAR(255),  -- Platform's session ID
    source_message_id VARCHAR(255),  -- Platform's message ID
    source_url TEXT,  -- If from web context
    
    -- Triple-operator relationships
    is_latest BOOLEAN DEFAULT TRUE,  -- For Updates relationship
    supersedes_id UUID REFERENCES memories(id),  -- Points to memory this updates
    
    -- Cognitive scoring
    strength REAL DEFAULT 1.0,  -- Ebbinghaus decay base
    recall_count INTEGER DEFAULT 0,
    importance_score REAL DEFAULT 0.5,  -- User/model assigned importance
    last_confirmed_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    -- Temporal grounding (dual-layer)
    document_date TIMESTAMPTZ,  -- When the interaction occurred
    event_dates TIMESTAMPTZ[],  -- When referenced events occurred
    
    -- Visibility & sharing
    visibility visibility_scope DEFAULT 'private',
    shared_with_orgs UUID[],  -- Organization IDs for org-level visibility
    
    -- Vector search metadata
    embedding_model VARCHAR(100) DEFAULT 'mistral-embed',
    embedding_dimension INTEGER DEFAULT 1024,
    embedding_version INTEGER DEFAULT 1,
    
    -- Compliance
    processing_basis VARCHAR(100) DEFAULT 'consent',  -- GDPR Article 6 basis
    retention_until TIMESTAMPTZ,  -- For data retention policies
    export_blocked BOOLEAN DEFAULT FALSE,  -- For legal holds
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    deleted_at TIMESTAMPTZ  -- Soft delete
);

-- Indexes for performance
CREATE INDEX idx_memories_user ON memories(user_id);
CREATE INDEX idx_memories_org ON memories(org_id);
CREATE INDEX idx_memories_type ON memories(memory_type);
CREATE INDEX idx_memories_latest ON memories(is_latest) WHERE is_latest = TRUE;
CREATE INDEX idx_memories_source ON memories(source_platform);
CREATE INDEX idx_memories_document_date ON memories(document_date DESC);
CREATE INDEX idx_memories_strength ON memories(strength DESC);
CREATE INDEX idx_memories_deleted ON memories(deleted_at) WHERE deleted_at IS NOT NULL;

-- Full-text search index (for hybrid search fallback)
CREATE INDEX idx_memories_content_fts ON memories USING GIN (to_tsvector('english', content));

-- ==========================================
-- RELATIONSHIPS (Graph edges)
-- ==========================================

CREATE TABLE relationships (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    from_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    to_id UUID NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    type relationship_type NOT NULL,
    
    -- Confidence scoring
    confidence REAL DEFAULT 1.0,
    inference_model VARCHAR(100),  -- Model that derived this relationship
    inference_prompt_hash VARCHAR(64),  -- For audit/reproducibility
    
    -- Metadata
    metadata JSONB DEFAULT '{}',
    created_by VARCHAR(50) DEFAULT 'system',  -- 'system', 'user', 'model'
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    
    UNIQUE(from_id, to_id, type)
);

-- Indexes for graph traversal
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
    
    -- Versioning for re-embedding
    embedding_version INTEGER DEFAULT 1,
    last_reembedded_at TIMESTAMPTZ,
    
    -- Sync status
    sync_status VARCHAR(50) DEFAULT 'synced',  -- synced, pending, failed
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
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Platform context
    platform_type VARCHAR(50) NOT NULL,
    platform_session_id VARCHAR(255),  -- External session ID
    
    -- Session metadata
    title VARCHAR(500),  -- Auto-generated
    message_count INTEGER DEFAULT 0,
    token_count INTEGER DEFAULT 0,
    
    -- Context injection tracking
    memories_injected UUID[],  -- Memory IDs injected into this session
    context_window_used INTEGER DEFAULT 0,
    compaction_triggered BOOLEAN DEFAULT FALSE,
    
    -- Lifecycle
    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    last_activity_at TIMESTAMPTZ,
    ended_at TIMESTAMPTZ,
    end_reason VARCHAR(50),  -- 'user_closed', 'timeout', 'compaction', 'error'
    
    -- Auto-captured decisions/lessons
    auto_captured_count INTEGER DEFAULT 0,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_platform ON sessions(platform_type);
CREATE INDEX idx_sessions_active ON sessions(user_id, ended_at) WHERE ended_at IS NULL;

-- ==========================================
-- SYNC LOGS (Audit trail for cross-platform sync)
-- ==========================================

CREATE TABLE sync_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    
    -- Sync event
    event_type VARCHAR(50) NOT NULL,  -- 'memory_created', 'memory_updated', 'context_synced'
    source_platform VARCHAR(50),
    target_platform VARCHAR(50),
    
    -- Payload
    memory_ids UUID[],
    session_id UUID REFERENCES sessions(id),
    payload_hash VARCHAR(64),  -- SHA-256 of sync payload
    
    -- Result
    status VARCHAR(50) DEFAULT 'success',  -- success, failed, partial
    error_message TEXT,
    retry_count INTEGER DEFAULT 0,
    
    -- Timing
    started_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    latency_ms INTEGER
);

CREATE INDEX idx_sync_logs_user ON sync_logs(user_id);
CREATE INDEX idx_sync_logs_event ON sync_logs(event_type);
CREATE INDEX idx_sync_logs_time ON sync_logs(started_at DESC);

-- ==========================================
-- APACHE AGE GRAPH NODES (Optional graph queries)
-- ==========================================

-- Create graph for complex relationship queries
SELECT create_graph('hivemind_memory_graph');

-- Cypher query example for Derives relationships:
-- SELECT * FROM cypher('hivemind_memory_graph', $$
--   MATCH (m1:Memory)-[:Derives*1..3]->(m2:Memory)
--   WHERE m1.user_id = 'uuid-here'
--   RETURN m1, m2, relationships(m1, m2)
-- $$) AS (m1 agtype, m2 agtype, rels agtype);

-- ==========================================
-- VIEWS FOR COMMON QUERIES
-- ==========================================

-- Active memories view (latest versions only)
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

-- Cross-platform sync status view
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
-- TRIGGERS FOR AUTOMATIC TIMESTAMP UPDATES
-- ==========================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = CURRENT_TIMESTAMP;
    RETURN NEW;
END;
$$ language 'plpgsql';

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

-- ==========================================
-- GDPR COMPLIANCE: DATA EXPORT/ERASURE
-- ==========================================

CREATE TABLE data_export_requests (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE CASCADE,
    request_type VARCHAR(50) NOT NULL,  -- 'export', 'erasure', 'portability'
    status VARCHAR(50) DEFAULT 'pending',  -- pending, processing, completed, failed
    export_format VARCHAR(20) DEFAULT 'json',  -- json, csv, parquet
    export_url TEXT,  -- Signed URL for download (expires in 24h)
    requested_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
    completed_at TIMESTAMPTZ,
    error_message TEXT
);

-- ==========================================
-- AUDIT LOGGING (NIS2/DORA compliance)
-- ==========================================

CREATE TABLE audit_logs (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    organization_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
    
    -- Event details
    event_type VARCHAR(100) NOT NULL,
    event_category VARCHAR(50),  -- 'auth', 'data_access', 'data_modification', 'system'
    resource_type VARCHAR(50),  -- 'memory', 'user', 'organization', 'integration'
    resource_id UUID,
    
    -- Action details
    action VARCHAR(50) NOT NULL,  -- create, read, update, delete, export, erase
    old_value JSONB,  -- Before state (for updates/deletes)
    new_value JSONB,  -- After state (for creates/updates)
    
    -- Context
    ip_address INET,
    user_agent TEXT,
    platform_type VARCHAR(50),
    session_id UUID,
    
    -- Compliance
    processing_basis VARCHAR(100),  -- GDPR Article 6
    legal_basis_note TEXT,
    
    created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX idx_audit_logs_user ON audit_logs(user_id);
CREATE INDEX idx_audit_logs_org ON audit_logs(organization_id);
CREATE INDEX idx_audit_logs_event ON audit_logs(event_type);
CREATE INDEX idx_audit_logs_time ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_logs_resource ON audit_logs(resource_type, resource_id);

-- Retention: 7 years for NIS2/DORA compliance
-- ALTER TABLE audit_logs SET (autovacuum_enabled = false);
```

### 2.2 Qdrant Collection Schema

```yaml
# Qdrant configuration for vector collections
# Deployed on EU infrastructure (Hetzner/Scaleway)

collections:
  - name: hivemind_memories
    vectors:
      size: 1024  # Mistral-embed dimension
      distance: Cosine
    hnsw_config:
      m: 16
      ef_construct: 100
      full_scan_threshold: 10000
    optimizers_config:
      indexation_threshold: 10000
      flush_interval_sec: 60
    wal_config:
      wal_capacity_mb: 32
      wal_segments_ahead: 0
    
    # Payload indexing for filtered search
    payload_index:
      - key: user_id
        type: keyword
        is_tenant_filter: true  # Critical for multi-tenant isolation
      - key: org_id
        type: keyword
      - key: memory_type
        type: keyword
      - key: tags
        type: keyword
        is_tenant_filter: false
      - key: source_platform
        type: keyword
      - key: is_latest
        type: bool
      - key: document_date
        type: datetime
      - key: importance_score
        type: float
      - key: visibility
        type: keyword

  - name: hivemind_sessions
    vectors:
      size: 1024
      distance: Cosine
    payload_index:
      - key: user_id
        type: keyword
        is_tenant_filter: true
      - key: platform_type
        type: keyword
      - key: started_at
        type: datetime
```

---

## 3. API Extensions

### 3.1 Authentication Endpoints

```yaml
openapi: 3.1.0
info:
  title: HIVE-MIND Cross-Platform API
  version: 1.0.0
  description: |
    REST API for cross-platform context synchronization.
    All endpoints require authentication via JWT (ZITADEL) or API keys.
    
    **Base URL:** `https://api.hivemind.io/v1`
    **EU Region:** `https://api-eu.hivemind.io/v1`

servers:
  - url: https://api.hivemind.io/v1
    description: Production (EU)
  - url: https://api-staging.hivemind.io/v1
    description: Staging

security:
  - bearerAuth: []
  - apiKeyAuth: []

components:
  securitySchemes:
    bearerAuth:
      type: http
      scheme: bearer
      bearerFormat: JWT
      description: JWT token from ZITADEL (OIDC)
    apiKeyAuth:
      type: apiKey
      in: header
      name: X-API-Key
      description: Platform API key (for server-to-server)

paths:
  # ==========================================
  # AUTHENTICATION
  # ==========================================
  
  /auth/login:
    post:
      summary: Initiate OIDC login flow
      tags: [Authentication]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                redirect_uri:
                  type: string
                  format: uri
                prompt:
                  type: string
                  enum: [login, consent, select_account]
      responses:
        '200':
          description: Authorization URL returned
          content:
            application/json:
              schema:
                type: object
                properties:
                  authorization_url:
                    type: string
                    format: uri
                  state:
                    type: string
  
  /auth/callback:
    get:
      summary: OIDC callback handler
      tags: [Authentication]
      parameters:
        - name: code
          in: query
          required: true
          schema:
            type: string
        - name: state
          in: query
          required: true
          schema:
            type: string
      responses:
        '302':
          description: Redirect to application with session cookie
          headers:
            Location:
              schema:
                type: string
            Set-Cookie:
              schema:
                type: string
  
  /auth/token:
    post:
      summary: Exchange refresh token for access token
      tags: [Authentication]
      requestBody:
        content:
          application/x-www-form-urlencoded:
            schema:
              type: object
              properties:
                grant_type:
                  type: string
                  enum: [refresh_token]
                refresh_token:
                  type: string
                client_id:
                  type: string
      responses:
        '200':
          description: New access token
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/TokenResponse'
  
  /auth/api-keys:
    get:
      summary: List user's API keys
      tags: [Authentication]
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/ApiKey'
    
    post:
      summary: Create new API key
      tags: [Authentication]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                name:
                  type: string
                scopes:
                  type: array
                  items:
                    type: string
                    enum: [memories:read, memories:write, sessions:read, sessions:write]
                expires_at:
                  type: string
                  format: date-time
      responses:
        '201':
          content:
            application/json:
              schema:
                type: object
                properties:
                  key:
                    type: string
                    description: "Full API key (shown only once)"
                  api_key:
                    $ref: '#/components/schemas/ApiKey'
  
  # ==========================================
  # PLATFORM INTEGRATIONS
  # ==========================================
  
  /integrations:
    get:
      summary: List connected platforms
      tags: [Integrations]
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/PlatformIntegration'
    
    post:
      summary: Connect new platform
      tags: [Integrations]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                platform_type:
                  type: string
                  enum: [chatgpt, claude, perplexity, gemini]
                auth_type:
                  type: string
                  enum: [oauth2, api_key, webhook]
                oauth_code:
                  type: string
                  description: "OAuth authorization code (for OAuth2 flow)"
                api_key:
                  type: string
                  description: "Platform API key (for API key auth)"
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/PlatformIntegration'
  
  /integrations/{platform_type}/disconnect:
    post:
      summary: Disconnect platform
      tags: [Integrations]
      parameters:
        - name: platform_type
          in: path
          required: true
          schema:
            type: string
      responses:
        '204':
          description: Platform disconnected
  
  # ==========================================
  # MEMORIES
  # ==========================================
  
  /memories:
    get:
      summary: List memories with filtering
      tags: [Memories]
      parameters:
        - name: type
          in: query
          schema:
            type: string
            enum: [fact, preference, decision, lesson, goal, event]
        - name: source_platform
          in: query
          schema:
            type: string
        - name: tags
          in: query
          schema:
            type: array
            items:
              type: string
        - name: limit
          in: query
          schema:
            type: integer
            default: 50
        - name: cursor
          in: query
          schema:
            type: string
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/MemoryListResponse'
    
    post:
      summary: Create new memory
      tags: [Memories]
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/MemoryCreateRequest'
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Memory'
  
  /memories/{memory_id}:
    get:
      summary: Get memory by ID with relationships
      tags: [Memories]
      parameters:
        - name: memory_id
          in: path
          required: true
          schema:
            type: string
            format: uuid
        - name: include_relationships
          in: query
          schema:
            type: boolean
            default: true
        - name: relationship_depth
          in: query
          schema:
            type: integer
            default: 2
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/MemoryWithRelationships'
    
    put:
      summary: Update memory
      tags: [Memories]
      parameters:
        - name: memory_id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        content:
          application/json:
            schema:
              $ref: '#/components/schemas/MemoryUpdateRequest'
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Memory'
    
    delete:
      summary: Soft delete memory (GDPR erasure)
      tags: [Memories]
      parameters:
        - name: memory_id
          in: path
          required: true
          schema:
            type: string
            format: uuid
        - name: permanent
          in: query
          schema:
            type: boolean
            default: false
      responses:
        '204':
          description: Memory deleted
  
  /memories/search:
    post:
      summary: Hybrid search (vector + keyword + graph)
      tags: [Memories]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                query:
                  type: string
                filters:
                  type: object
                  properties:
                    memory_type:
                      type: array
                      items:
                        type: string
                    source_platform:
                      type: string
                    tags:
                      type: array
                      items:
                        type: string
                    date_from:
                      type: string
                      format: date-time
                    date_to:
                      type: string
                      format: date-time
                weights:
                  type: object
                  properties:
                    similarity:
                      type: number
                      default: 0.5
                    recency:
                      type: number
                      default: 0.3
                    importance:
                      type: number
                      default: 0.2
                n_results:
                  type: integer
                  default: 10
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  results:
                    type: array
                    items:
                      $ref: '#/components/schemas/MemoryWithScore'
                  query_time_ms:
                    type: integer
  
  /memories/traverse:
    post:
      summary: Graph traversal from starting memory
      tags: [Memories]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              required:
                - start_id
              properties:
                start_id:
                  type: string
                  format: uuid
                depth:
                  type: integer
                  default: 3
                relationship_types:
                  type: array
                  items:
                    type: string
                    enum: [Updates, Extends, Derives]
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/GraphTraversalResult'
  
  # ==========================================
  # CONTEXT SYNC (Cross-platform)
  # ==========================================
  
  /sync/context:
    post:
      summary: Sync context to all connected platforms
      tags: [Sync]
      description: |
        Pushes relevant memories to all connected AI platforms.
        Used when user switches platforms or starts new session.
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                target_platforms:
                  type: array
                  items:
                    type: string
                    enum: [chatgpt, claude, perplexity, gemini]
                context_query:
                  type: string
                  description: "Query to determine relevant memories"
                max_memories:
                  type: integer
                  default: 10
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  synced_to:
                    type: array
                    items:
                      type: string
                  failed:
                    type: array
                    items:
                      type: object
                      properties:
                        platform:
                          type: string
                        error:
                          type: string
                  memories_synced:
                    type: integer
  
  /sync/webhook/{platform_type}:
    post:
      summary: Platform webhook endpoint
      tags: [Sync]
      description: |
        Receives events from AI platforms (new messages, session ends).
        Signature verified via HMAC.
      parameters:
        - name: platform_type
          in: path
          required: true
          schema:
            type: string
      requestBody:
        content:
          application/json:
            schema:
              oneOf:
                - $ref: '#/components/schemas/ChatGPTWebhook'
                - $ref: '#/components/schemas/ClaudeWebhook'
      responses:
        '200':
          description: Webhook processed
        '401':
          description: Invalid signature
  
  # ==========================================
  # SESSIONS
  # ==========================================
  
  /sessions:
    get:
      summary: List user sessions
      tags: [Sessions]
      parameters:
        - name: platform_type
          in: query
          schema:
            type: string
        - name: status
          in: query
          schema:
            type: string
            enum: [active, ended]
      responses:
        '200':
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: '#/components/schemas/Session'
    
    post:
      summary: Start new session
      tags: [Sessions]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                platform_type:
                  type: string
                platform_session_id:
                  type: string
                initial_context:
                  type: string
      responses:
        '201':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Session'
  
  /sessions/{session_id}:
    get:
      summary: Get session details
      tags: [Sessions]
      parameters:
        - name: session_id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Session'
  
  /sessions/{session_id}/end:
    post:
      summary: End session with auto-capture
      tags: [Sessions]
      parameters:
        - name: session_id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                session_transcript:
                  type: string
                auto_capture_decisions:
                  type: boolean
                  default: true
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  session:
                    $ref: '#/components/schemas/Session'
                  captured_memories:
                    type: array
                    items:
                      $ref: '#/components/schemas/Memory'
  
  # ==========================================
  # COMPLIANCE (GDPR)
  # ==========================================
  
  /compliance/export:
    post:
      summary: Request data export (GDPR Article 20)
      tags: [Compliance]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                format:
                  type: string
                  enum: [json, csv, parquet]
                include_deleted:
                  type: boolean
                  default: false
      responses:
        '202':
          content:
            application/json:
              schema:
                type: object
                properties:
                  request_id:
                    type: string
                    format: uuid
                  status:
                    type: string
                  estimated_completion:
                    type: string
                    format: date-time
  
  /compliance/export/{request_id}:
    get:
      summary: Get export request status
      tags: [Compliance]
      parameters:
        - name: request_id
          in: path
          required: true
          schema:
            type: string
            format: uuid
      responses:
        '200':
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/ExportRequest'
  
  /compliance/erasure:
    post:
      summary: Request data erasure (GDPR Article 17)
      tags: [Compliance]
      requestBody:
        content:
          application/json:
            schema:
              type: object
              properties:
                scope:
                  type: string
                  enum: [all, memories, sessions, integrations]
                reason:
                  type: string
      responses:
        '202':
          content:
            application/json:
              schema:
                type: object
                properties:
                  request_id:
                    type: string
                    format: uuid
  
  # ==========================================
  # HEALTH & MONITORING
  # ==========================================
  
  /health:
    get:
      summary: Health check
      tags: [System]
      responses:
        '200':
          content:
            application/json:
              schema:
                type: object
                properties:
                  status:
                    type: string
                    enum: [healthy, degraded, unhealthy]
                  services:
                    type: object
                    properties:
                      database:
                        type: string
                      vector_store:
                        type: string
                      redis:
                        type: string
  
  /metrics:
    get:
      summary: Prometheus metrics endpoint
      tags: [System]
      responses:
        '200':
          content:
            text/plain:
              schema:
                type: string

components:
  schemas:
    # ==========================================
    # SCHEMA DEFINITIONS
    # ==========================================
    
    TokenResponse:
      type: object
      properties:
        access_token:
          type: string
        token_type:
          type: string
          enum: [Bearer]
        expires_in:
          type: integer
        refresh_token:
          type: string
        scope:
          type: string
    
    ApiKey:
      type: object
      properties:
        id:
          type: string
          format: uuid
        name:
          type: string
        scopes:
          type: array
          items:
            type: string
        created_at:
          type: string
          format: date-time
        expires_at:
          type: string
          format: date-time
        last_used_at:
          type: string
          format: date-time
    
    PlatformIntegration:
      type: object
      properties:
        id:
          type: string
          format: uuid
        platform_type:
          type: string
        platform_display_name:
          type: string
        auth_type:
          type: string
        is_active:
          type: boolean
        sync_status:
          type: string
        last_synced_at:
          type: string
          format: date-time
        created_at:
          type: string
          format: date-time
    
    Memory:
      type: object
      properties:
        id:
          type: string
          format: uuid
        content:
          type: string
        memory_type:
          type: string
        title:
          type: string
        tags:
          type: array
          items:
            type: string
        source_platform:
          type: string
        is_latest:
          type: boolean
        strength:
          type: number
        recall_count:
          type: integer
        document_date:
          type: string
          format: date-time
        created_at:
          type: string
          format: date-time
        updated_at:
          type: string
          format: date-time
    
    MemoryCreateRequest:
      type: object
      required:
        - content
      properties:
        content:
          type: string
        memory_type:
          type: string
          enum: [fact, preference, decision, lesson, goal, event]
        title:
          type: string
        tags:
          type: array
          items:
            type: string
        source_platform:
          type: string
        relationship:
          type: object
          properties:
            type:
              type: string
              enum: [Updates, Extends, Derives]
            target_id:
              type: string
              format: uuid
        document_date:
          type: string
          format: date-time
        event_dates:
          type: array
          items:
            type: string
            format: date-time
    
    MemoryUpdateRequest:
      type: object
      properties:
        content:
          type: string
        title:
          type: string
        tags:
          type: array
          items:
            type: string
        importance_score:
          type: number
        visibility:
          type: string
          enum: [private, organization, public]
    
    MemoryWithRelationships:
      allOf:
        - $ref: '#/components/schemas/Memory'
        - type: object
          properties:
            relationships:
              type: array
              items:
                type: object
                properties:
                  id:
                    type: string
                    format: uuid
                  type:
                    type: string
                    enum: [Updates, Extends, Derives]
                  related_memory:
                    $ref: '#/components/schemas/Memory'
    
    MemoryWithScore:
      allOf:
        - $ref: '#/components/schemas/Memory'
        - type: object
          properties:
            score:
              type: number
            score_breakdown:
              type: object
              properties:
                similarity:
                  type: number
                recency:
                  type: number
                importance:
                  type: number
    
    MemoryListResponse:
      type: object
      properties:
        memories:
          type: array
          items:
            $ref: '#/components/schemas/Memory'
        next_cursor:
          type: string
        has_more:
          type: boolean
    
    GraphTraversalResult:
      type: object
      properties:
        nodes:
          type: array
          items:
            $ref: '#/components/schemas/Memory'
        edges:
          type: array
          items:
            type: object
            properties:
              from_id:
                type: string
              to_id:
                type: string
              type:
                type: string
              confidence:
                type: number
        paths:
          type: array
          items:
            type: object
    
    Session:
      type: object
      properties:
        id:
          type: string
          format: uuid
        platform_type:
          type: string
        platform_session_id:
          type: string
        title:
          type: string
        message_count:
          type: integer
        started_at:
          type: string
          format: date-time
        last_activity_at:
          type: string
          format: date-time
        ended_at:
          type: string
          format: date-time
    
    ChatGPTWebhook:
      type: object
      properties:
        event_type:
          type: string
          enum: [message.created, session.started, session.ended]
        user:
          type: object
          properties:
            id:
              type: string
            email:
              type: string
        session:
          type: object
          properties:
            id:
              type: string
        message:
          type: object
          properties:
            id:
              type: string
            content:
              type: string
            role:
              type: string
        timestamp:
          type: string
          format: date-time
    
    ClaudeWebhook:
      type: object
      properties:
        type:
          type: string
          enum: [message, conversation_end]
        user_id:
          type: string
        conversation_id:
          type: string
        message:
          type: object
          properties:
            id:
              type: string
            content:
              type: string
            role:
              type: string
        created_at:
          type: string
          format: date-time
    
    ExportRequest:
      type: object
      properties:
        id:
          type: string
          format: uuid
        user_id:
          type: string
          format: uuid
        request_type:
          type: string
        status:
          type: string
        format:
          type: string
        export_url:
          type: string
        requested_at:
          type: string
          format: date-time
        completed_at:
          type: string
          format: date-time
```

---

## 4. Integration Patterns

### 4.1 ChatGPT Integration (Custom GPT Actions)

**Architecture:**
```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   ChatGPT   │────▶│  Custom GPT      │────▶│  HIVE-MIND      │
│   (User)    │     │  Actions API     │     │  /api/memories  │
└─────────────┘     └──────────────────┘     └─────────────────┘
                           │                        │
                           │ OAuth 2.0              │ JWT Validation
                           ▼                        ▼
                    ┌──────────────────┐     ┌─────────────────┐
                    │   ZITADEL        │     │   Memory Store  │
                    │   (IAM)          │     │   + Sync        │
                    └──────────────────┘     └─────────────────┘
```

**Implementation:**

```javascript
// Custom GPT Action Configuration (OpenAI GPT Builder)
const chatgptActions = {
  // Store memory from conversation
  store_memory: {
    method: 'POST',
    url: 'https://api.hivemind.io/v1/memories',
    headers: {
      'Authorization': 'Bearer {{oauth_token}}',
      'Content-Type': 'application/json'
    },
    body: {
      content: '{{message_content}}',
      memory_type: '{{inferred_type}}',
      source_platform: 'chatgpt',
      source_session_id: '{{conversation_id}}',
      source_message_id: '{{message_id}}',
      tags: '{{extracted_tags}}',
      document_date: '{{timestamp}}'
    }
  },
  
  // Recall context for current conversation
  recall_context: {
    method: 'POST',
    url: 'https://api.hivemind.io/v1/memories/search',
    headers: {
      'Authorization': 'Bearer {{oauth_token}}',
      'Content-Type': 'application/json'
    },
    body: {
      query: '{{conversation_context}}',
      filters: {
        source_platform: ['chatgpt', 'claude', '*'], // Cross-platform
        date_from: '{{30_days_ago}}'
      },
      weights: {
        similarity: 0.5,
        recency: 0.3,
        importance: 0.2
      },
      n_results: 10
    }
  },
  
  // End session with auto-capture
  end_session: {
    method: 'POST',
    url: 'https://api.hivemind.io/v1/sessions/{{session_id}}/end',
    headers: {
      'Authorization': 'Bearer {{oauth_token}}',
      'Content-Type': 'application/json'
    },
    body: {
      session_transcript: '{{full_transcript}}',
      auto_capture_decisions: true
    }
  }
};

// OAuth 2.0 Flow Implementation
class ChatGPTOAuth {
  constructor(config) {
    this.clientId = config.client_id;
    this.clientSecret = config.client_secret;
    this.redirectUri = config.redirect_uri;
    this.zitadelUrl = config.zitadel_url;
  }
  
  // Step 1: Generate authorization URL
  getAuthorizationUrl(state) {
    const params = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: this.redirectUri,
      response_type: 'code',
      scope: 'openid profile email memories:read memories:write',
      state: state,
      code_challenge: this.generatePKCE(),
      code_challenge_method: 'S256'
    });
    
    return `${this.zitadelUrl}/oauth/v2/authorize?${params.toString()}`;
  }
  
  // Step 2: Exchange code for tokens
  async exchangeCode(code) {
    const response = await fetch(`${this.zitadelUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: code,
        redirect_uri: this.redirectUri,
        client_id: this.clientId,
        client_secret: this.clientSecret
      })
    });
    
    if (!response.ok) {
      throw new Error(`Token exchange failed: ${response.statusText}`);
    }
    
    return response.json();
  }
  
  // Step 3: Refresh token
  async refreshToken(refreshToken) {
    const response = await fetch(`${this.zitadelUrl}/oauth/v2/token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded'
      },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: this.clientId,
        client_secret: this.clientSecret
      })
    });
    
    return response.json();
  }
  
  generatePKCE() {
    const array = new Uint8Array(32);
    crypto.getRandomValues(array);
    return this.base64UrlEncode(array);
  }
  
  base64UrlEncode(buffer) {
    return btoa(String.fromCharCode(...buffer))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
  }
}
```

### 4.2 Claude Integration (Actions API)

**Architecture:**
```
┌─────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Claude    │────▶│  Claude Actions  │────▶│  HIVE-MIND      │
│   (User)    │     │  (API Key)       │     │  /api/recall    │
└─────────────┘     └──────────────────┘     └─────────────────┘
                           │                        │
                           │ API Key Auth           │ HMAC Verify
                           ▼                        ▼
                    ┌──────────────────┐     ┌─────────────────┐
                    │   API Key Store  │     │   Context       │
                    │   (Hashed)       │     │   Injection     │
                    └──────────────────┘     └─────────────────┘
```

**Implementation:**

```javascript
// Claude Actions API Configuration
const claudeActions = {
  // System prompt for auto-recall
  systemPrompt: `
<hive-mind-context>
You have access to HIVE-MIND, a cross-platform memory system.
Before responding, check for relevant memories using the recall tool.
Inject retrieved memories naturally into your response.
</hive-mind-context>
  `,
  
  // Tool definition for Claude
  tools: [
    {
      name: 'hivemind_recall',
      description: 'Retrieve relevant memories from HIVE-MIND cross-platform context',
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Search query for relevant memories'
          },
          max_results: {
            type: 'integer',
            default: 5
          }
        },
        required: ['query']
      }
    },
    {
      name: 'hivemind_store',
      description: 'Store important information to HIVE-MIND for future recall',
      input_schema: {
        type: 'object',
        properties: {
          content: {
            type: 'string',
            description: 'Information to remember'
          },
          type: {
            type: 'string',
            enum: ['fact', 'preference', 'decision', 'lesson', 'goal']
          },
          tags: {
            type: 'array',
            items: { type: 'string' }
          }
        },
        required: ['content']
      }
    }
  ]
};

// Claude API Client with HIVE-MIND integration
class ClaudeHiveMindClient {
  constructor(config) {
    this.anthropicKey = config.anthropic_key;
    this.hivemindApiKey = config.hivemind_api_key;
    this.hivemindUrl = 'https://api.hivemind.io/v1';
  }
  
  async chat(messages, options = {}) {
    // Step 1: Auto-recall relevant context
    const contextQuery = this.buildContextQuery(messages);
    const memories = await this.recallContext(contextQuery);
    
    // Step 2: Inject memories into system prompt
    const systemPrompt = this.buildSystemPrompt(memories);
    
    // Step 3: Call Claude API
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': this.anthropicKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-20250514',
        max_tokens: 4096,
        system: systemPrompt,
        messages: messages,
        tools: claudeActions.tools
      })
    });
    
    const result = await response.json();
    
    // Step 4: Auto-capture decisions/lessons from response
    if (options.auto_capture) {
      await this.autoCapture(result.content, messages);
    }
    
    return result;
  }
  
  async recallContext(query, maxResults = 5) {
    const response = await fetch(`${this.hivemindUrl}/memories/search`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.hivemindApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        query: query,
        n_results: maxResults,
        weights: {
          similarity: 0.5,
          recency: 0.3,
          importance: 0.2
        }
      })
    });
    
    const data = await response.json();
    return data.results;
  }
  
  buildSystemPrompt(memories) {
    if (memories.length === 0) {
      return claudeActions.systemPrompt;
    }
    
    const memoryContext = memories.map(m => 
      `- [${m.memory_type}] ${m.content} (from ${m.source_platform || 'unknown'})`
    ).join('\n');
    
    return `
${claudeActions.systemPrompt}

<relevant-memories>
${memoryContext}
</relevant-memories>

Use these memories to personalize your responses. Reference them naturally when relevant.
    `.trim();
  }
  
  buildContextQuery(messages) {
    // Extract key topics from recent messages
    const recentMessages = messages.slice(-3);
    return recentMessages.map(m => m.content).join(' ');
  }
  
  async autoCapture(responseContent, conversationHistory) {
    const decisionKeywords = ['decided', 'decision', 'chose', 'will use', 'going with'];
    const lessonKeywords = ['lesson', 'learned', 'important', 'remember', 'note that'];
    
    const sentences = responseContent.split(/[.!?]+/);
    
    for (const sentence of sentences) {
      const lower = sentence.toLowerCase().trim();
      
      if (decisionKeywords.some(k => lower.includes(k))) {
        await this.storeMemory({
          content: `Decision: ${sentence.trim()}`,
          type: 'decision',
          tags: ['auto-captured', 'claude']
        });
      }
      
      if (lessonKeywords.some(k => lower.includes(k))) {
        await this.storeMemory({
          content: `Lesson: ${sentence.trim()}`,
          type: 'lesson',
          tags: ['auto-captured', 'claude']
        });
      }
    }
  }
  
  async storeMemory(memory) {
    await fetch(`${this.hivemindUrl}/memories`, {
      method: 'POST',
      headers: {
        'X-API-Key': this.hivemindApiKey,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        ...memory,
        source_platform: 'claude'
      })
    });
  }
}
```

### 4.3 Generic Platform Integration (Webhooks)

```javascript
// Webhook handler for platforms without native Actions support
class PlatformWebhookHandler {
  constructor(config) {
    this.hmacSecret = config.hmac_secret;
    this.supportedPlatforms = {
      perplexity: this.handlePerplexity.bind(this),
      gemini: this.handleGemini.bind(this),
      custom: this.handleCustom.bind(this)
    };
  }
  
  // Verify HMAC signature
  verifySignature(payload, signature, platform) {
    const secret = this.hmacSecret[platform];
    const expectedSignature = crypto
      .createHmac('sha256', secret)
      .update(payload)
      .digest('hex');
    
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'hex'),
      Buffer.from(expectedSignature, 'hex')
    );
  }
  
  async handleWebhook(platform, payload, signature) {
    // Verify signature
    if (!this.verifySignature(payload, signature, platform)) {
      throw new Error('Invalid webhook signature');
    }
    
    const event = JSON.parse(payload);
    const handler = this.supportedPlatforms[platform];
    
    if (!handler) {
      throw new Error(`Unsupported platform: ${platform}`);
    }
    
    return handler(event);
  }
  
  async handlePerplexity(event) {
    // Perplexity webhook format
    if (event.type === 'query_completed') {
      await this.storeMemory({
        content: `Query: ${event.query}\nAnswer: ${event.answer_summary}`,
        type: 'fact',
        source_platform: 'perplexity',
        source_url: event.source_url
      });
    }
  }
  
  async handleGemini(event) {
    // Google Gemini webhook format
    if (event.type === 'conversation_message') {
      await this.processMessage({
        platform: 'gemini',
        content: event.message.content,
        role: event.message.role,
        session_id: event.conversation_id
      });
    }
  }
  
  async handleCustom(event) {
    // Generic webhook format
    await this.processMessage({
      platform: event.platform || 'custom',
      content: event.content,
      role: event.role,
      session_id: event.session_id
    });
  }
  
  async processMessage({ platform, content, role, session_id }) {
    // Store user messages as potential memories
    if (role === 'user') {
      // Use LLM to extract memory-worthy content
      const extracted = await this.extractMemories(content);
      
      for (const memory of extracted) {
        await this.storeMemory({
          ...memory,
          source_platform: platform,
          source_session_id: session_id
        });
      }
    }
  }
  
  async extractMemories(content) {
    // Call LLM to extract structured memories
    // Implementation depends on your LLM provider
    return [];
  }
  
  async storeMemory(memory) {
    // Store to HIVE-MIND
    await fetch('https://api.hivemind.io/v1/memories', {
      method: 'POST',
      headers: {
        'X-API-Key': process.env.HIVEMIND_API_KEY,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(memory)
    });
  }
}
```

---

## 5. Test Plan

### 5.1 Test Categories

| Category | Tests | Priority | Automation |
|----------|-------|----------|------------|
| **Unit Tests** | 150+ | P0 | ✅ Jest/Vitest |
| **Integration Tests** | 80+ | P0 | ✅ Docker Compose |
| **E2E Tests** | 40+ | P1 | ✅ Playwright |
| **Load Tests** | 20+ | P1 | ✅ k6 |
| **Security Tests** | 30+ | P0 | ✅ OWASP ZAP |
| **Compliance Tests** | 25+ | P0 | ✅ Custom scripts |

### 5.2 Critical Test Scenarios

```yaml
# Test Scenario 1: Cross-Platform Context Sync
test_cross_platform_sync:
  description: "Verify context persists when switching from ChatGPT to Claude"
  steps:
    - name: "Setup"
      actions:
        - create_user: { email: "test@example.com" }
        - connect_platform: { platform: "chatgpt", oauth: true }
        - connect_platform: { platform: "claude", api_key: true }
    
    - name: "ChatGPT Session"
      actions:
        - send_message:
            platform: chatgpt
            content: "I'm using TypeScript for my backend and PostgreSQL for the database"
        - verify_memory_stored:
            content_contains: "TypeScript"
            source_platform: chatgpt
    
    - name: "Claude Session (Different Platform)"
      actions:
        - send_message:
            platform: claude
            content: "What backend stack am I using?"
        - verify_context_injected:
            expected_content: "TypeScript"
            expected_content: "PostgreSQL"
        - assert_response_contains:
            content: "You mentioned using TypeScript and PostgreSQL"
    
    - name: "Verification"
      actions:
        - query_memories:
            user_email: "test@example.com"
            filter: { source_platform: "chatgpt" }
        - assert_count: { min: 1 }
        - verify_sync_log_exists:
            event_type: "context_synced"
            source_platform: "chatgpt"
            target_platform: "claude"

# Test Scenario 2: Real-Time Sync Latency
test_sync_latency:
  description: "Verify context sync completes within SLA (<300ms P99)"
  steps:
    - name: "Baseline Measurement"
      actions:
        - store_memory: { content: "Test memory 1" }
        - measure_latency: { metric: "memory_store_p50", threshold_ms: 100 }
        - measure_latency: { metric: "memory_store_p99", threshold_ms: 300 }
    
    - name: "Cross-Platform Sync"
      actions:
        - trigger_sync: { target_platforms: ["chatgpt", "claude"] }
        - measure_latency: { metric: "sync_p50", threshold_ms: 200 }
        - measure_latency: { metric: "sync_p99", threshold_ms: 300 }
    
    - name: "Concurrent Load"
      actions:
        - spawn_concurrent_users: { count: 100 }
        - measure_latency: { metric: "concurrent_sync_p99", threshold_ms: 500 }

# Test Scenario 3: GDPR Compliance
test_gdpr_compliance:
  description: "Verify GDPR data export and erasure"
  steps:
    - name: "Data Export"
      actions:
        - request_export: { format: "json", user_email: "test@example.com" }
        - wait_for_completion: { timeout_minutes: 5 }
        - download_export: { verify_signed_url: true }
        - verify_export_contains:
            - memories
            - sessions
            - platform_integrations
            - audit_logs
    
    - name: "Data Erasure"
      actions:
        - request_erasure: { scope: "all", user_email: "test@example.com" }
        - wait_for_completion: { timeout_minutes: 5 }
        - verify_data_deleted:
            table: memories
            user_email: "test@example.com"
        - verify_audit_log_exists:
            action: "erasure"
            resource_type: "user"
    
    - name: "Right to Portability"
      actions:
        - request_export: { format: "parquet", user_email: "test@example.com" }
        - verify_machine_readable: true
        - verify_schema_compliant: { standard: "GDPR_Article_20" }

# Test Scenario 4: EU Data Sovereignty
test_eu_sovereignty:
  description: "Verify data never leaves EU jurisdiction"
  steps:
    - name: "Infrastructure Verification"
      actions:
        - check_database_location: { expected_region: "eu-central" }
        - check_vector_store_location: { expected_region: "eu-west" }
        - check_hsm_provider: { expected: "ovhcloud", country: "FR" }
    
    - name: "Data Residency"
      actions:
        - store_memory: { content: "Test" }
        - query_database_metadata:
            verify: { encryption: "LUKS2", key_location: "EU" }
    
    - name: "Network Egress"
      actions:
        - monitor_network_traffic: { duration_minutes: 10 }
        - verify_no_egress_to:
            - "US"
            - "CN"
            - "RU"
        - verify_all_egress_to:
            - "DE"
            - "FR"
            - "FI"

# Test Scenario 5: Conflict Resolution
test_conflict_resolution:
  description: "Verify conflicting memories are handled correctly"
  steps:
    - name: "Create Conflicting Memories"
      actions:
        - store_memory:
            content: "I use TypeScript"
            document_date: "2025-01-01"
        - store_memory:
            content: "I use Python"
            document_date: "2025-03-01"
            relationship: { type: "Updates", target_id: "$first_memory" }
    
    - name: "Verify Latest Version"
      actions:
        - query_memories: { filter: { is_latest: true } }
        - assert_count: 1
        - assert_content_contains: "Python"
    
    - name: "Verify History Preserved"
      actions:
        - traverse_graph: { start_id: "$second_memory", depth: 2 }
        - assert_relationship_exists:
            type: "Updates"
            from: "$second_memory"
            to: "$first_memory"
```

### 5.3 Load Testing (k6)

```javascript
// k6 load test script
import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate } from 'k6/metrics';

// Custom metrics
const errorRate = new Rate('errors');
const syncSuccessRate = new Rate('sync_success');

export const options = {
  stages: [
    { duration: '2m', target: 100 },   // Ramp to 100 users
    { duration: '5m', target: 100 },   // Stay at 100
    { duration: '2m', target: 500 },   // Ramp to 500
    { duration: '5m', target: 500 },   // Stay at 500
    { duration: '2m', target: 1000 },  // Ramp to 1000 (stress)
    { duration: '5m', target: 1000 },  // Stay at 1000
    { duration: '2m', target: 0 },     // Ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<500'],  // 95% under 500ms
    http_req_failed: ['rate<0.01'],    // Error rate < 1%
    errors: ['rate<0.01'],
    sync_success: ['rate>0.99'],
  },
};

export default function () {
  const userId = `user_${__VU}`;
  const token = getAuthToken(userId);
  
  // Test 1: Store memory
  const storeRes = http.post(
    'https://api.hivemind.io/v1/memories',
    JSON.stringify({
      content: `Test memory from user ${userId}`,
      memory_type: 'fact',
      tags: ['load-test']
    }),
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  check(storeRes, {
    'store memory: status is 201': (r) => r.status === 201,
  });
  errorRate.add(storeRes.status !== 201);
  
  sleep(1);
  
  // Test 2: Search memories
  const searchRes = http.post(
    'https://api.hivemind.io/v1/memories/search',
    JSON.stringify({
      query: 'load test',
      n_results: 10
    }),
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  check(searchRes, {
    'search memories: status is 200': (r) => r.status === 200,
    'search memories: has results': (r) => {
      const body = r.json();
      return body.results && body.results.length > 0;
    }
  });
  
  sleep(1);
  
  // Test 3: Cross-platform sync
  const syncRes = http.post(
    'https://api.hivemind.io/v1/sync/context',
    JSON.stringify({
      target_platforms: ['chatgpt', 'claude'],
      context_query: 'load test'
    }),
    {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    }
  );
  
  check(syncRes, {
    'sync context: status is 200': (r) => r.status === 200,
  });
  syncSuccessRate.add(syncRes.status === 200);
  
  sleep(2);
}

function getAuthToken(userId) {
  // Mock token generation - replace with actual OAuth flow
  return `mock_token_${userId}`;
}
```

---

## 6. Recommended Tech Stack (EU Sovereign)

### 6.1 Infrastructure Layer

| Component | Technology | Provider | Region | Rationale |
|-----------|-----------|----------|--------|-----------|
| **Compute** | Kubernetes (K3s) | Hetzner | DE/FI | Best price/performance, full GDPR |
| **Managed DB** | PostgreSQL 15 | Scaleway | FR-Paris | LUKS encryption, pgvector ready |
| **Vector Store** | Qdrant Cloud | Scaleway | FR-Paris | EU deployment, filtered search |
| **Cache/PubSub** | Redis Cloud | AWS (eu-central-1) | DE-Frankfurt | Only EU region, managed service |
| **HSM** | Managed HSM | OVHcloud | FR-Paris | SecNumCloud qualified, HYOK support |
| **Object Storage** | S3-Compatible | Scaleway | FR-Paris | For backups, exports |
| **CDN** | BunnyCDN | Bunny.net | EU POPs | EU-owned, GDPR compliant |
| **DNS** | PowerDNS | Self-hosted | Hetzner | Full control, EU-only |

### 6.2 Application Layer

| Component | Technology | Version | Notes |
|-----------|-----------|---------|-------|
| **Runtime** | Node.js | 20 LTS | ES Modules, native fetch |
| **Framework** | Fastify | 4.x | High performance, low overhead |
| **Auth** | ZITADEL | 2.x | Event-sourced, NIS2 compliant |
| **ORM** | Drizzle ORM | 0.x | TypeScript-first, SQL-like |
| **Queue** | BullMQ | 5.x | Redis-based, priority queues |
| **API Docs** | OpenAPI 3.1 | - | Auto-generated from types |
| **Testing** | Vitest + Playwright | Latest | Unit + E2E |
| **Monitoring** | Prometheus + Grafana | Latest | Self-hosted |
| **Logging** | Loki + Promtail | Latest | Self-hosted |
| **Tracing** | Jaeger | Latest | Self-hosted |

### 6.3 AI/ML Layer

| Component | Technology | Provider | Notes |
|-----------|-----------|----------|-------|
| **Embeddings** | Mistral-embed | Mistral AI | EU-based, 1024 dim |
| **LLM (Fallback)** | Mistral Large 2 | Mistral AI | EU-based, function calling |
| **LLM (Premium)** | Aleph Alpha Luminous | Aleph Alpha | German, BSI-certified |
| **Local Embeddings** | Ollama + nomic-embed | Self-hosted | For dev/testing |

### 6.4 Security & Compliance

| Component | Technology | Standard | Notes |
|-----------|-----------|----------|-------|
| **TLS** | TLS 1.3 | - | EU-only certs (Sovereign CA) |
| **Encryption at Rest** | LUKS2 | AES-256-XTS | All volumes |
| **Encryption in Transit** | mTLS | - | Internal service mesh |
| **Key Management** | HYOK Pattern | - | Hold Your Own Key |
| **Secrets** | Doppler / Vault | - | EU-hosted |
| **WAF** | Traefik + ModSecurity | - | OWASP CRS 3.3 |
| **Audit Logging** | ZITADEL + Custom | NIS2/DORA | 7-year retention |

### 6.5 Deployment Architecture

```yaml
# docker-compose.production.yml (EU Sovereign Stack)
version: "3.8"

services:
  # API Gateway (Traefik with EU TLS)
  traefik:
    image: traefik:v3.0
    labels:
      - "traefik.enable=true"
      - "traefik.http.routers.api.tls.certresolver=letsencrypt"
      - "traefik.http.routers.api.tls.domains[0].main=api.hivemind.io"
      # EU-only TLS configuration
      - "traefik.http.options.tls.minVersion=VersionTLS13"
      - "traefik.http.options.tls.cipherSuites=TLS_AES_256_GCM_SHA384"
  
  # Core API (Fastify + Node.js)
  api:
    build: ./core
    environment:
      - NODE_ENV=production
      - DATABASE_URL=postgres://user:pass@postgres:5432/hivemind
      - QDRANT_URL=http://qdrant:6333
      - REDIS_URL=redis://redis:6379
      - ZITADEL_URL=https://auth.hivemind.io
      - EMBEDDING_MODEL=mistral-embed
      - EMBEDDING_API_KEY=${MISTRAL_API_KEY}
      - HSM_KEY_ID=${OVH_HSM_KEY_ID}
    depends_on:
      - postgres
      - qdrant
      - redis
  
  # PostgreSQL (Scaleway Managed or Self-hosted)
  postgres:
    image: apache/age:latest  # PostgreSQL + Apache AGE
    command:
      - postgres
      - -cshared_preload_libraries=age
    environment:
      - POSTGRES_USER=hivemind
      - POSTGRES_PASSWORD=${DB_PASSWORD}
      - POSTGRES_DB=hivemind
    volumes:
      - postgres_data:/var/lib/postgresql/data
      # LUKS2 encrypted volume mount
      - type: volume
        source: postgres_encrypted
        target: /var/lib/postgresql/data
        volume:
          nocopy: true
  
  # Qdrant (Vector Store)
  qdrant:
    image: qdrant/qdrant:latest
    volumes:
      - qdrant_data:/qdrant/storage
    environment:
      - QDRANT__TELEMETRY_DISABLED=true
      - QDRANT__SERVICE__GRPC_PORT=6334
  
  # Redis (Session State + Pub/Sub)
  redis:
    image: redis:7-alpine
    command: redis-server --appendonly yes
    volumes:
      - redis_data:/data
  
  # ZITADEL (IAM)
  zitadel:
    image: ghcr.io/zitadel/zitadel:latest
    environment:
      - ZITADEL_DATABASE_POSTGRES_HOST=postgres
      - ZITADEL_EXTERNALSECURE=true
      - ZITADEL_EXTERNALDOMAIN=auth.hivemind.io
    command: start-from-init --masterkey ${ZITADEL_MASTERKEY}
  
  # Worker (Background Jobs)
  worker:
    build: ./worker
    environment:
      - DATABASE_URL=postgres://user:pass@postgres:5432/hivemind
      - QDRANT_URL=http://qdrant:6333
      - REDIS_URL=redis://redis:6379
    deploy:
      replicas: 3
      resources:
        limits:
          cpus: '2'
          memory: 4G
  
  # Backup (Daily to Scaleway S3)
  backup:
    image: offen/docker-volume-backup:latest
    environment:
      - BACKUP_CRON_EXPRESSION=0 2 * * *
      - BACKUP_RETENTION_DAYS=30
      - AWS_S3_BUCKET_NAME=hivemind-backups
      - AWS_S3_ENDPOINT=s3.fr-par.scw.cloud  # Scaleway Paris
      - AWS_ACCESS_KEY_ID=${SCW_ACCESS_KEY}
      - AWS_SECRET_ACCESS_KEY=${SCW_SECRET_KEY}
      - GPG_PASSPHRASE=${BACKUP_GPG_PASSPHRASE}
    volumes:
      - postgres_data:/backup/postgres:ro
      - qdrant_data:/backup/qdrant:ro

volumes:
  postgres_data:
    driver: local
    driver_opts:
      type: luks
      device: /dev/sda1  # Encrypted volume
  qdrant_data:
    driver: local
  redis_data:
    driver: local
```

### 6.6 Cost Estimate (Monthly, Production)

| Resource | Configuration | Provider | Monthly Cost (EUR) |
|----------|--------------|----------|-------------------|
| **Compute** | 3x CX31 (4 vCPU, 8GB) | Hetzner | €40.50 |
| **Managed PostgreSQL** | 2 vCPU, 8GB, 100GB | Scaleway | €85.00 |
| **Qdrant Cloud** | 2 vCPU, 8GB, 50GB | Scaleway | €75.00 |
| **Redis Cloud** | 5GB, EU | Redis Cloud | €50.00 |
| **Managed HSM** | Single-tenant | OVHcloud | €200.00 |
| **Object Storage** | 500GB + egress | Scaleway | €15.00 |
| **CDN** | 1TB transfer | BunnyCDN | €10.00 |
| **Mistral AI API** | 1M tokens/day | Mistral AI | €300.00 |
| **Monitoring** | Self-hosted | Hetzner | €20.00 |
| **Total** | - | - | **€795.50/month** |

---

## 7. Migration Path

### Phase 1: Foundation (Weeks 1-2)
- [ ] Deploy PostgreSQL + Apache AGE on Scaleway
- [ ] Deploy Qdrant on Scaleway
- [ ] Migrate existing SQLite data to PostgreSQL
- [ ] Implement ZITADEL authentication

### Phase 2: Platform Integrations (Weeks 3-4)
- [ ] Build ChatGPT Custom GPT Actions
- [ ] Build Claude Actions API integration
- [ ] Implement webhook handler for generic platforms
- [ ] Add OAuth 2.0 flow for ChatGPT

### Phase 3: Cross-Platform Sync (Weeks 5-6)
- [ ] Implement real-time sync engine (Redis Pub/Sub)
- [ ] Build conflict resolution logic
- [ ] Add sync status dashboard
- [ ] Implement retry logic with exponential backoff

### Phase 4: Compliance & Security (Weeks 7-8)
- [ ] Implement GDPR export/erasure APIs
- [ ] Add audit logging (NIS2/DORA)
- [ ] Configure LUKS2 encryption
- [ ] Integrate OVHcloud HSM for HYOK

### Phase 5: Performance & Scale (Weeks 9-10)
- [ ] Load testing with k6
- [ ] Optimize database queries
- [ ] Implement caching layer
- [ ] Set up monitoring (Prometheus + Grafana)

### Phase 6: Production Launch (Weeks 11-12)
- [ ] Security audit (OWASP ZAP)
- [ ] Compliance audit (GDPR, NIS2)
- [ ] Beta testing with 100 users
- [ ] Production deployment

---

## 8. Risk Mitigation

| Risk | Impact | Probability | Mitigation |
|------|--------|-------------|------------|
| **Platform API Changes** | High | Medium | Abstract adapter layer, versioned APIs |
| **OAuth Token Expiry** | Medium | High | Automatic refresh, fallback to API keys |
| **Cross-Platform Conflicts** | High | Medium | Last-write-wins with user override |
| **GDPR Non-Compliance** | Critical | Low | Legal review, automated compliance tests |
| **Data Breach** | Critical | Low | LUKS2 + HSM, zero-trust architecture |
| **Vendor Lock-in** | Medium | Low | Multi-provider strategy, open standards |
| **Latency SLA Breach** | High | Medium | Caching, CDN, edge deployment |

---

## 9. Success Metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| **Cross-Platform Sync Latency (P99)** | <300ms | Prometheus histogram |
| **Memory Retrieval Accuracy** | >95% | User feedback + automated tests |
| **Platform Uptime** | 99.9% | Uptime monitoring |
| **GDPR Request Completion** | <72 hours | Compliance dashboard |
| **User Retention (30-day)** | >60% | Analytics |
| **Context Recall Precision** | >90% | A/B testing |
| **Sync Success Rate** | >99% | Sync logs |

---

## Appendix A: Glossary

| Term | Definition |
|------|------------|
| **HYOK** | Hold Your Own Key - Customer controls encryption keys |
| **LUKS2** | Linux Unified Key Setup - Disk encryption standard |
| **Apache AGE** | Graph database extension for PostgreSQL |
| **ZITADEL** | Swiss IAM provider, GDPR-compliant |
| **SecNumCloud** | French security certification for cloud providers |
| **NIS2** | EU Directive on network and information security |
| **DORA** | Digital Operational Resilience Act (EU) |

---

## Appendix B: API Rate Limits

| Endpoint | Rate Limit | Burst |
|----------|-----------|-------|
| `/api/memories` | 100 req/min | 200 |
| `/api/memories/search` | 60 req/min | 100 |
| `/api/sync/context` | 30 req/min | 50 |
| `/api/webhook/*` | 500 req/min | 1000 |
| `/api/compliance/export` | 5 req/hour | 10 |

---

**Document Version:** 1.0  
**Last Updated:** March 9, 2026  
**Owner:** HIVE-MIND Architecture Team  
**Classification:** Internal + Partners

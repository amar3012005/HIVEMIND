# HIVE-MIND Database Setup Guide

## PostgreSQL 15 + Apache AGE Implementation

**Version:** 1.0.0  
**Compliance:** GDPR, NIS2, DORA  
**Data Residency:** EU (DE/FR/FI)  
**Last Updated:** March 9, 2026

---

## Table of Contents

1. [Quick Start](#quick-start)
2. [Prerequisites](#prerequisites)
3. [Architecture Overview](#architecture-overview)
4. [Database Schema](#database-schema)
5. [Local Development Setup](#local-development-setup)
6. [Production Deployment](#production-deployment)
7. [Migration Guide](#migration-guide)
8. [Compliance Notes](#compliance-notes)
9. [Troubleshooting](#troubleshooting)

---

## Quick Start

```bash
# 1. Clone and navigate to project
cd /Users/amar/HIVE-MIND

# 2. Start development stack
docker-compose -f infra/docker-compose.dev.yml up -d

# 3. Copy environment file
cp core/.env.example core/.env

# 4. Install dependencies
cd core && npm install

# 5. Run Prisma migrations
npx prisma migrate deploy

# 6. Seed development data
npm run db:seed

# 7. Verify setup
curl http://localhost:3000/health
```

---

## Prerequisites

### Required Software

| Software | Version | Purpose |
|----------|---------|---------|
| Node.js | >= 20.x | Runtime environment |
| PostgreSQL | 15.x | Primary database |
| Docker | >= 24.x | Containerization |
| Docker Compose | >= 2.x | Orchestration |
| Prisma CLI | >= 5.x | Database ORM |

### Installation Commands

```bash
# macOS (Homebrew)
brew install node@20 postgresql@15 docker

# Install Prisma CLI globally
npm install -g prisma

# Verify installations
node --version      # v20.x.x
psql --version      # 15.x
docker --version    # 24.x.x
prisma --version    # 5.x.x
```

---

## Architecture Overview

### Component Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    HIVE-MIND Platform                        │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────────┐    ┌──────────────┐    ┌──────────────┐  │
│  │   ChatGPT    │    │    Claude    │    │   Perplexity │  │
│  │   Adapter    │    │    Adapter   │    │    Adapter   │  │
│  └──────┬───────┘    └──────┬───────┘    └──────┬───────┘  │
│         │                   │                   │          │
│         └───────────────────┼───────────────────┘          │
│                             │                               │
│                    ┌────────▼────────┐                      │
│                    │   API Gateway   │                      │
│                    │   (Traefik)     │                      │
│                    └────────┬────────┘                      │
│                             │                               │
│  ┌──────────────────────────┼──────────────────────────┐   │
│  │                      Core Services                   │   │
│  │  ┌──────────┐  ┌──────────┐  ┌──────────┐          │   │
│  │  │   Auth   │  │  Memory  │  │  Vector  │          │   │
│  │  │ (ZITADEL)│  │ Service  │  │ (Qdrant) │          │   │
│  │  └──────────┘  └──────────┘  └──────────┘          │   │
│  └──────────────────────────┼──────────────────────────┘   │
│                             │                               │
│  ┌──────────────────────────┼──────────────────────────┐   │
│  │                   Data Layer                         │   │
│  │  ┌──────────────────┐   ┌──────────────────┐        │   │
│  │  │   PostgreSQL 15  │   │     Qdrant       │        │   │
│  │  │   + Apache AGE   │   │   (Vectors)      │        │   │
│  │  │   (Graph DB)     │   │                  │        │   │
│  │  └──────────────────┘   └──────────────────┘        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **User Interaction** → AI Platform (ChatGPT/Claude)
2. **Platform** → HIVE-MIND API (via Custom GPT Action / Actions API)
3. **API** → Auth Service (JWT validation via ZITADEL)
4. **Auth** → Memory Service (CRUD operations)
5. **Memory** → PostgreSQL (relational) + Apache AGE (graph)
6. **Vector** → Qdrant (semantic search embeddings)

---

## Database Schema

### Core Tables

| Table | Purpose | Key Features |
|-------|---------|--------------|
| `users` | User accounts | ZITADEL integration, HYOK encryption keys |
| `organizations` | Multi-tenant orgs | Data residency, compliance flags |
| `memories` | Core memory storage | Triple-operator versioning, cognitive scoring |
| `relationships` | Graph edges | Updates, Extends, Derives relationships |
| `platform_integrations` | OAuth/API auth | Encrypted tokens, sync status |
| `vector_embeddings` | Qdrant sync | Vector metadata, sync tracking |
| `sessions` | Cross-platform sessions | Context injection tracking |
| `audit_logs` | Compliance audit | 7-year retention (NIS2/DORA) |

### Apache AGE Graph

```sql
-- Create graph
SELECT create_graph('hivemind_memory_graph');

-- Query example: Find all memories derived from a specific memory
SELECT * FROM cypher('hivemind_memory_graph', $$
  MATCH (m1:Memory)-[:Derives*1..3]->(m2:Memory)
  WHERE m1.user_id = 'uuid-here'
  RETURN m1, m2, relationships(m1, m2)
$$) AS (m1 agtype, m2 agtype, rels agtype);
```

### Indexes

| Table | Index | Type | Purpose |
|-------|-------|------|---------|
| `memories` | `idx_memories_user` | B-tree | User isolation |
| `memories` | `idx_memories_latest` | Partial | Latest version filter |
| `memories` | `idx_memories_content_fts` | GIN | Full-text search |
| `memories` | `idx_memories_tags` | GIN | Tag array queries |
| `relationships` | `idx_relationships_from` | B-tree | Graph traversal |
| `relationships` | `idx_relationships_to` | B-tree | Graph traversal |
| `audit_logs` | `idx_audit_logs_time` | B-tree | Time-based queries |

---

## Local Development Setup

### Step 1: Clone Repository

```bash
git clone <repository-url>
cd HIVE-MIND
```

### Step 2: Configure Environment

```bash
# Copy example environment
cp core/.env.example core/.env

# Generate secure random values
openssl rand -hex 32  # For MCP_AUTH_SECRET
openssl rand -hex 32  # For HSM_MASTER_KEY
```

### Step 3: Start Development Stack

```bash
# Start all services
docker-compose -f infra/docker-compose.dev.yml up -d

# Check service health
docker-compose -f infra/docker-compose.dev.yml ps

# View logs
docker-compose -f infra/docker-compose.dev.yml logs -f postgres
```

### Step 4: Initialize Database

```bash
cd core

# Install dependencies
npm install

# Run Prisma migrations
npx prisma migrate deploy

# Seed development data
npm run db:seed
```

### Step 5: Verify Setup

```bash
# Check PostgreSQL connection
psql postgres://hivemind:hivemind_dev_password@localhost:5432/hivemind -c "SELECT version();"

# Check Apache AGE
psql postgres://hivemind:hivemind_dev_password@localhost:5432/hivemind -c "LOAD 'age'; SET search_path = ag_catalog, public; SELECT * FROM ag_graph;"

# Check Qdrant
curl http://localhost:6333/collections

# Check API health
curl http://localhost:3000/health
```

### Step 6: Access Development Tools

| Tool | URL | Credentials |
|------|-----|-------------|
| pgAdmin | http://localhost:5050 | admin@hivemind.local / admin |
| ZITADEL | http://localhost:8080 | admin@hivemind.local / DevPassword123! |
| Qdrant Dashboard | http://localhost:6333/dashboard | API key: dev_api_key |
| API Endpoint | http://localhost:3000 | Bearer token required |

---

## Production Deployment

### Infrastructure Requirements

| Component | Specification | Provider |
|-----------|---------------|----------|
| PostgreSQL | 8 vCPU, 32GB RAM, 500GB NVMe | Scaleway Managed PostgreSQL |
| Qdrant | 4 vCPU, 16GB RAM, 200GB NVMe | Hetzner AX52 |
| Redis | 2 vCPU, 4GB RAM | Hetzner CPX31 |
| Application | 4 vCPU, 8GB RAM | Hetzner CX52 |

### Security Configuration

```bash
# 1. Enable SSL/TLS
# Update DATABASE_URL with sslmode=require
DATABASE_URL=postgres://user:pass@host:5432/db?sslmode=require

# 2. Configure HSM for HYOK
# Set OVHcloud HSM credentials
OVH_HSM_KEY_ID=your-key-id
HSM_TYPE=ovhcloud

# 3. Enable RLS policies
# All tables have RLS enabled by default
# Set app context in application: SELECT set_app_context('user-uuid', 'org-uuid');
```

### Deployment Steps

```bash
# 1. Build production image
docker-compose -f infra/docker-compose.sovereign.yml build

# 2. Deploy to EU infrastructure
./infra/deploy.sh

# 3. Run migrations
npx prisma migrate deploy

# 4. Verify health
curl https://api.hivemind.io/health
```

---

## Migration Guide

### From In-Memory to PostgreSQL

```bash
# 1. Backup existing in-memory data
curl http://localhost:3000/api/memories/export > backup.json

# 2. Stop existing service
docker stop hivemind-legacy

# 3. Start new PostgreSQL stack
docker-compose -f infra/docker-compose.dev.yml up -d

# 4. Run migration script
node scripts/migrate-from-memory.js backup.json

# 5. Verify migration
psql postgres://hivemind:pass@localhost:5432/hivemind -c "SELECT COUNT(*) FROM memories;"
```

### Prisma Migration Commands

```bash
# Create new migration
npx prisma migrate dev --name add_new_column

# Deploy to production
npx prisma migrate deploy

# Reset database (development only)
npx prisma migrate reset

# Generate Prisma Client
npx prisma generate
```

---

## Compliance Notes

### GDPR Compliance

| Requirement | Implementation |
|-------------|----------------|
| Right to Erasure | `deleted_at` soft delete, `data_export_requests` table |
| Data Portability | Export API with JSON/CSV/Parquet formats |
| Consent Management | `processing_basis` field in memories |
| Data Minimization | Configurable retention policies |

### NIS2 / DORA Compliance

| Requirement | Implementation |
|-------------|----------------|
| Audit Trail | `audit_logs` table with 7-year retention |
| Incident Reporting | `sync_logs` with error tracking |
| Business Continuity | Backup service with Scaleway S3 |
| Encryption | HYOK pattern with OVHcloud HSM |

### Data Residency

All data is stored in EU regions only:

- **Primary:** eu-central (Hetzner, Nuremberg)
- **Backup:** eu-west (Scaleway, Paris)
- **HSM:** eu-west (OVHcloud, Gravelines)

---

## Troubleshooting

### Common Issues

#### PostgreSQL Connection Failed

```bash
# Check if PostgreSQL is running
docker ps | grep postgres

# Check connection string
echo $DATABASE_URL

# Test connection
psql $DATABASE_URL -c "SELECT 1;"
```

#### Apache AGE Not Loading

```sql
-- Manually load AGE extension
LOAD 'age';
SET search_path = ag_catalog, public;

-- Verify graph exists
SELECT * FROM ag_graph WHERE name = 'hivemind_memory_graph';
```

#### Prisma Migration Failed

```bash
# Check migration status
npx prisma migrate status

# Resolve conflicts
npx prisma migrate resolve --applied "001_initial_schema"

# Re-run migration
npx prisma migrate deploy
```

#### Qdrant Sync Issues

```bash
# Check Qdrant health
curl http://localhost:6333/healthz

# Check collections
curl http://localhost:6333/collections

# Reset collection (development only)
curl -X DELETE http://localhost:6333/collections/hivemind_memories
```

### Log Locations

| Service | Log Command |
|---------|-------------|
| PostgreSQL | `docker logs hivemind-postgres-dev` |
| Qdrant | `docker logs hivemind-qdrant-dev` |
| MCP Server | `docker logs hivemind-mcp-dev` |
| ZITADEL | `docker logs hivemind-zitadel-dev` |

### Support

For additional help:

1. Check documentation: `/specs/backend-engineer-spec.md`
2. Review schema: `/core/src/db/schema.sql`
3. Contact: security@hivemind.local (for compliance issues)

---

## Appendix: File Structure

```
HIVE-MIND/
├── core/
│   ├── src/db/
│   │   ├── schema.sql          # Full DDL with Apache AGE
│   │   └── seed.ts             # Development seed script
│   ├── prisma/
│   │   ├── schema.prisma       # Prisma ORM schema
│   │   └── migrations/
│   │       └── 001_initial_schema/
│   │           ├── migration.sql
│   │           ├── up.sql
│   │           └── down.sql
│   └── .env.example
├── infra/
│   ├── docker-compose.dev.yml  # Development stack
│   ├── docker-compose.sovereign.yml  # Production stack
│   ├── init-scripts/
│   │   └── 01-init-hivemind.sql
│   ├── pgadmin/
│   │   └── servers.json
│   └── qdrant/
│       └── config.yaml
└── specs/
    └── backend-engineer-spec.md
```

---

**Document Version:** 1.0.0  
**Last Updated:** March 9, 2026  
**Maintained By:** HIVE-MIND Backend Team

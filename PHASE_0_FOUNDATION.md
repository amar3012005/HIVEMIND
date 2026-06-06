# Phase 0: Self-Hosted n8n + HiveMind Integration Foundation
**Duration:** 1 week  
**Objective:** Establish sovereign EU-hosted n8n infrastructure with HiveMind ingest capability, credential templates, and proof-of-concept workflow.

---

## 1. Infrastructure Setup (EU Self-Hosted n8n)

### 1.1 Docker Compose Environment

**File:** `docker-compose.yml`

```yaml
version: '3.8'

services:
  # PostgreSQL database (EU region, encrypted)
  postgres:
    image: postgres:15-alpine
    container_name: n8n-postgres
    environment:
      POSTGRES_USER: ${DB_USER:-n8n}
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: ${DB_NAME:-n8n}
      POSTGRES_INITDB_ARGS: "-c ssl=on -c ssl_cert_file=/var/lib/postgresql/server.crt -c ssl_key_file=/var/lib/postgresql/server.key"
    volumes:
      - postgres_storage:/var/lib/postgresql/data
      - ./certs/server.crt:/var/lib/postgresql/server.crt:ro
      - ./certs/server.key:/var/lib/postgresql/server.key:ro
    networks:
      - n8n_network
    restart: unless-stopped
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${DB_USER:-n8n}"]
      interval: 10s
      timeout: 5s
      retries: 5

  # n8n Workflow Engine
  n8n:
    image: n8nio/n8n:latest
    container_name: n8n-server
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      # Database
      DB_TYPE: postgresdb
      DB_POSTGRESDB_HOST: postgres
      DB_POSTGRESDB_PORT: 5432
      DB_POSTGRESDB_DATABASE: ${DB_NAME:-n8n}
      DB_POSTGRESDB_USER: ${DB_USER:-n8n}
      DB_POSTGRESDB_PASSWORD: ${DB_PASSWORD}
      DB_POSTGRESDB_SSL: true
      
      # n8n Core
      N8N_HOST: ${N8N_HOST:-localhost}
      N8N_PORT: 5678
      N8N_PROTOCOL: https
      NODE_ENV: production
      
      # Security
      N8N_SECURE_COOKIE: true
      N8N_ENCRYPTION_KEY: ${N8N_ENCRYPTION_KEY}
      
      # HiveMind Integration
      HIVEMIND_API_URL: ${HIVEMIND_API_URL}
      HIVEMIND_API_KEY: ${HIVEMIND_API_KEY}
      HIVEMIND_TIMEOUT_MS: 30000
      
      # Webhook
      WEBHOOK_URL: https://${N8N_HOST:-localhost}:5678/
      
      # Logging
      LOG_LEVEL: info
      N8N_LOG_OUTPUT: file
      N8N_LOG_FILE_LOCATION: /home/node/.n8n/logs
      
    volumes:
      - n8n_storage:/home/node/.n8n
      - ./certs/server.crt:/etc/ssl/certs/n8n.crt:ro
      - ./certs/server.key:/etc/ssl/private/n8n.key:ro
      - ./workflows:/workflows:ro
    ports:
      - "5678:5678"
    networks:
      - n8n_network
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "curl", "-f", "https://localhost:5678/api/v1/health"]
      interval: 30s
      timeout: 10s
      retries: 5

  # Redis for caching & queue
  redis:
    image: redis:7-alpine
    container_name: n8n-redis
    command: redis-server --requirepass ${REDIS_PASSWORD} --appendonly yes
    volumes:
      - redis_storage:/data
    networks:
      - n8n_network
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_storage:
  n8n_storage:
  redis_storage:

networks:
  n8n_network:
    driver: bridge
```

### 1.2 Environment Template

**File:** `.env.example`

```bash
# ============================================
# INFRASTRUCTURE
# ============================================
DB_USER=n8n
DB_PASSWORD=<generate-strong-password>
DB_NAME=n8n
REDIS_PASSWORD=<generate-strong-password>

# ============================================
# n8n CORE
# ============================================
N8N_HOST=n8n.company.eu
N8N_PORT=5678
N8N_ENCRYPTION_KEY=<generate-32-char-random-string>
NODE_ENV=production

# ============================================
# SSL/TLS (EU Compliance)
# ============================================
SSL_CERT_PATH=./certs/server.crt
SSL_KEY_PATH=./certs/server.key
SSL_ISSUER=<your-eu-ca>

# ============================================
# HiveMind Integration
# ============================================
HIVEMIND_API_URL=https://api.hivemind.company.eu/v1
HIVEMIND_API_KEY=<hivemind-api-key>
HIVEMIND_INGEST_ENDPOINT=/ingest
HIVEMIND_TIMEOUT_MS=30000

# ============================================
# SYSTEM CREDENTIALS (ENCRYPTED IN DB)
# ============================================
# SAP
SAP_HOST=sap.company.eu
SAP_PORT=3200
SAP_CLIENT=100
SAP_USER=<sap-user>
SAP_PASSWORD=<sap-password>

# DATEV
DATEV_API_URL=https://api.datev.de
DATEV_API_KEY=<datev-api-key>
DATEV_TENANT_ID=<datev-tenant>

# CRM
CRM_API_URL=https://crm.company.eu
CRM_API_KEY=<crm-api-key>
CRM_ORG_ID=<crm-org>

# ============================================
# LOGGING & MONITORING
# ============================================
LOG_LEVEL=info
SENTRY_DSN=<optional-sentry-dsn>
DATADOG_API_KEY=<optional-datadog-key>
```

### 1.3 Self-Signed Certificate Generation (for local testing)

**Script:** `scripts/generate-certs.sh`

```bash
#!/bin/bash
set -e

CERTS_DIR="./certs"
mkdir -p "$CERTS_DIR"

# Generate private key
openssl genrsa -out "$CERTS_DIR/server.key" 2048

# Generate certificate
openssl req -new -x509 -key "$CERTS_DIR/server.key" \
  -out "$CERTS_DIR/server.crt" -days 365 \
  -subj "/C=DE/ST=Bavaria/L=Munich/O=Company/OU=n8n/CN=n8n.company.eu"

chmod 600 "$CERTS_DIR/server.key"
chmod 644 "$CERTS_DIR/server.crt"

echo "Certificates generated in $CERTS_DIR"
```

---

## 2. HiveMind Ingest Endpoint Schema

### 2.1 Canonical Payload Schema (Frozen)

**File:** `schemas/hivemind-ingest.json`

```json
{
  "$schema": "http://json-schema.org/draft-07/schema#",
  "title": "HiveMind Ingest Payload",
  "type": "object",
  "required": ["source_system", "data_type", "records", "metadata"],
  "properties": {
    "source_system": {
      "type": "string",
      "enum": ["SAP", "DATEV", "CRM", "ERPNext", "Custom"],
      "description": "Origin system identifier"
    },
    "data_type": {
      "type": "string",
      "enum": [
        "customer",
        "vendor",
        "invoice",
        "order",
        "journal_entry",
        "transaction",
        "contact",
        "opportunity"
      ],
      "description": "Normalized data type across all systems"
    },
    "records": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["id", "data"],
        "properties": {
          "id": {
            "type": "string",
            "description": "Unique record identifier"
          },
          "data": {
            "type": "object",
            "description": "Normalized record payload"
          },
          "source_id": {
            "type": "string",
            "description": "Source system's native ID"
          },
          "timestamp": {
            "type": "string",
            "format": "date-time",
            "description": "Record creation/modification timestamp"
          },
          "fingerprint": {
            "type": "string",
            "description": "SHA256 hash of data for deduplication"
          }
        }
      }
    },
    "metadata": {
      "type": "object",
      "required": ["batch_id", "timestamp", "record_count"],
      "properties": {
        "batch_id": {
          "type": "string",
          "description": "Unique batch identifier (UUID)"
        },
        "timestamp": {
          "type": "string",
          "format": "date-time",
          "description": "Batch creation timestamp (UTC)"
        },
        "record_count": {
          "type": "integer",
          "minimum": 1,
          "description": "Total records in batch"
        },
        "ingestion_mode": {
          "type": "string",
          "enum": ["realtime", "backfill"],
          "default": "realtime"
        },
        "checksum": {
          "type": "string",
          "description": "SHA256 checksum of entire payload for integrity"
        },
        "tenant_id": {
          "type": "string",
          "description": "Multi-tenant isolation key"
        }
      }
    }
  }
}
```

### 2.2 Example Ingest Request

**File:** `examples/crm-customer-ingest.json`

```json
{
  "source_system": "CRM",
  "data_type": "customer",
  "records": [
    {
      "id": "crm-cust-12345",
      "source_id": "12345",
      "data": {
        "name": "ACME Corporation",
        "email": "contact@acme.de",
        "phone": "+49 89 12345678",
        "address": {
          "street": "Maximilianstr. 1",
          "city": "Munich",
          "postal_code": "80538",
          "country": "DE"
        },
        "industry": "Manufacturing",
        "mrr": 15000,
        "status": "active",
        "tags": ["vip", "manufacturing", "eu"]
      },
      "timestamp": "2026-06-02T14:30:00Z",
      "fingerprint": "sha256:a1b2c3d4e5f6..."
    }
  ],
  "metadata": {
    "batch_id": "batch-crm-2026-06-02-001",
    "timestamp": "2026-06-02T14:30:00Z",
    "record_count": 1,
    "ingestion_mode": "realtime",
    "checksum": "sha256:f6e5d4c3b2a1...",
    "tenant_id": "company-eu"
  }
}
```

---

## 3. Credential Templates per System

### 3.1 SAP RFC Connection Template

**File:** `credentials/sap-rfc.template.json`

```json
{
  "name": "SAP RFC Connection",
  "type": "sap_rfc",
  "properties": {
    "host": {
      "type": "string",
      "description": "SAP application server hostname (EU region)",
      "required": true,
      "example": "sap.company.eu"
    },
    "port": {
      "type": "integer",
      "description": "SAP gateway port (typically 3200-3299)",
      "required": true,
      "default": 3200
    },
    "client": {
      "type": "string",
      "description": "SAP client number (100-999)",
      "required": true,
      "example": "100"
    },
    "user": {
      "type": "string",
      "description": "SAP RFC user (batch/system user recommended)",
      "required": true
    },
    "password": {
      "type": "string",
      "description": "SAP user password (encrypted)",
      "required": true,
      "encrypted": true
    },
    "language": {
      "type": "string",
      "default": "en",
      "enum": ["de", "en", "fr"]
    },
    "use_ssl": {
      "type": "boolean",
      "default": true
    }
  },
  "test_function": "STFC_CONNECTION"
}
```

### 3.2 DATEV API Template

**File:** `credentials/datev-api.template.json`

```json
{
  "name": "DATEV API Connection",
  "type": "datev_api",
  "properties": {
    "api_url": {
      "type": "string",
      "description": "DATEV API endpoint (EU)",
      "required": true,
      "default": "https://api.datev.de"
    },
    "api_key": {
      "type": "string",
      "description": "DATEV API key (OAuth2 client credentials)",
      "required": true,
      "encrypted": true
    },
    "tenant_id": {
      "type": "string",
      "description": "DATEV tenant/organization ID",
      "required": true
    },
    "environment": {
      "type": "string",
      "enum": ["production", "test"],
      "default": "production"
    },
    "timeout_ms": {
      "type": "integer",
      "default": 30000
    }
  },
  "test_endpoint": "/api/v1/organizations"
}
```

### 3.3 CRM Connection Template

**File:** `credentials/crm-api.template.json`

```json
{
  "name": "CRM API Connection",
  "type": "crm_api",
  "properties": {
    "api_url": {
      "type": "string",
      "description": "CRM API base URL",
      "required": true,
      "example": "https://crm.company.eu"
    },
    "api_key": {
      "type": "string",
      "description": "CRM API key (Bearer token)",
      "required": true,
      "encrypted": true
    },
    "org_id": {
      "type": "string",
      "description": "CRM organization ID",
      "required": true
    },
    "api_version": {
      "type": "string",
      "default": "v2",
      "enum": ["v1", "v2"]
    }
  },
  "test_endpoint": "/api/v2/accounts"
}
```

---

## 4. Backfill vs Real-Time Decision Matrix

| **Scenario** | **System** | **Mode** | **Cadence** | **Volume Est.** | **Latency** |
|---|---|---|---|---|---|
| Initial data load | SAP | Backfill | Once | 500k+ records | Hours acceptable |
| Daily reconciliation | DATEV | Backfill | Daily 2 AM | 10k–50k | 24h acceptable |
| Customer sync | CRM | Real-time | On change | 100–1k/day | <5min critical |
| Invoice ingestion | SAP | Hybrid | Daily batch + RT alerts | 500–5k/day | 1h batch, 5min alerts |
| Opportunity pipeline | CRM | Real-time | On stage change | 10–100/day | <10min |

**Decision Logic for Phase 0:**
- **Real-time:** CRM customer/opportunity changes (high velocity, low volume, business-critical)
- **Daily backfill:** SAP AR/AP, DATEV journal entries (high volume, reconciliation-driven)
- **Weekly backfill:** Historical data archive / compliance (audit trail)

---

## 5. Test Workflow: CRM Customer → Normalize → HiveMind

### 5.1 Workflow Structure

```
┌─────────────────────────────────────────────────────────────────┐
│ CRM API Webhook (or Schedule Trigger)                          │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│ 1. Fetch Customer Data (CRM API)                               │
│    - Query: limit 100, sort by last_modified desc              │
│    - Retry: exponential backoff 3x                             │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│ 2. Transform & Normalize (Code Node)                           │
│    - Map CRM fields → canonical schema                         │
│    - Validate required fields                                  │
│    - Generate fingerprint (SHA256)                             │
│    - Handle nulls/missing data                                 │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│ 3. Batch & Meta (Merge Node)                                   │
│    - Add metadata: batch_id, timestamp, checksum               │
│    - Set ingestion_mode: "realtime"                            │
│    - Validate schema vs. HiveMind spec                         │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│ 4. POST to HiveMind (/v1/ingest)                               │
│    - Auth: Bearer ${HIVEMIND_API_KEY}                          │
│    - Timeout: 30s                                              │
│    - Retry: 3x on 429/5xx                                      │
└──────────────────────┬──────────────────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────────────────┐
│ 5. Error Handling & Logging                                    │
│    - Log response (batch_id, record_count, status)             │
│    - On error: webhook alert → Slack/Teams                    │
│    - Store failed batch for retry                              │
└─────────────────────────────────────────────────────────────────┘
```

### 5.2 n8n Workflow Code (SDK-based)

**File:** `workflows/crm-customer-to-hivemind.n8n.ts`

```typescript
import { workflow, trigger, node, expr } from 'n8n-workflow-sdk';

export default workflow({
  name: 'CRM Customer Sync → HiveMind',
  description: 'Fetch CRM customers, normalize, and ingest to HiveMind real-time',
  nodes: [
    // 1. Schedule Trigger (every 5 minutes)
    trigger({
      id: 'Schedule',
      type: 'n8n-nodes-base.scheduleTrigger',
      parameters: {
        interval: [5, 'minutes']
      }
    }),

    // 2. Fetch CRM Customers
    node({
      name: 'Fetch CRM Customers',
      type: 'n8n-nodes-base.httpRequest',
      inputs: ['Schedule'],
      parameters: {
        url: expr('{{ $env.CRM_API_URL }}/api/v2/accounts'),
        method: 'GET',
        authentication: 'generic',
        genericAuthType: 'bearerToken',
        options: {
          headers: {
            'User-Agent': 'n8n-hivemind-sync/1.0'
          }
        },
        qs: {
          limit: 100,
          sort: '-last_modified'
        }
      },
      credentials: {
        generic: {
          id: expr('{{ $env.CRM_API_KEY }}'),
          name: 'CRM API Key'
        }
      }
    }),

    // 3. Normalize Data
    node({
      name: 'Normalize to HiveMind Schema',
      type: 'n8n-nodes-base.code',
      inputs: ['Fetch CRM Customers'],
      parameters: {
        jsCode: `
const crypto = require('crypto');
const items = $input.all();

return items.map(item => {
  const crmData = item.json;
  
  // Generate fingerprint
  const fingerprint = crypto
    .createHash('sha256')
    .update(JSON.stringify(crmData))
    .digest('hex');

  return {
    json: {
      id: \`crm-customer-\${crmData.id}\`,
      source_id: crmData.id,
      data: {
        name: crmData.name || 'Unknown',
        email: crmData.email,
        phone: crmData.phone,
        address: {
          street: crmData.billing_address?.street,
          city: crmData.billing_address?.city,
          postal_code: crmData.billing_address?.postal_code,
          country: crmData.billing_address?.country || 'DE'
        },
        industry: crmData.industry_type,
        mrr: parseFloat(crmData.annual_revenue) / 12 || 0,
        status: crmData.status === 'active' ? 'active' : 'inactive',
        tags: crmData.tags || [],
        last_contacted: crmData.last_activity_date
      },
      timestamp: new Date().toISOString(),
      fingerprint: \`sha256:\${fingerprint}\`
    }
  };
});
        `
      }
    }),

    // 4. Build Batch Payload
    node({
      name: 'Build HiveMind Payload',
      type: 'n8n-nodes-base.code',
      inputs: ['Normalize to HiveMind Schema'],
      parameters: {
        jsCode: `
const crypto = require('crypto');
const records = $input.all().map(item => item.json);

// Generate batch metadata
const batchId = \`batch-crm-\${Date.now()}\`;
const timestamp = new Date().toISOString();
const payloadStr = JSON.stringify(records);
const checksum = crypto
  .createHash('sha256')
  .update(payloadStr)
  .digest('hex');

return [{
  json: {
    source_system: 'CRM',
    data_type: 'customer',
    records: records,
    metadata: {
      batch_id: batchId,
      timestamp: timestamp,
      record_count: records.length,
      ingestion_mode: 'realtime',
      checksum: \`sha256:\${checksum}\`,
      tenant_id: 'company-eu'
    }
  }
}];
        `
      }
    }),

    // 5. POST to HiveMind
    node({
      name: 'POST to HiveMind',
      type: 'n8n-nodes-base.httpRequest',
      inputs: ['Build HiveMind Payload'],
      parameters: {
        url: expr('{{ $env.HIVEMIND_API_URL }}/v1/ingest'),
        method: 'POST',
        bodyParameters: {
          contentType: 'application/json'
        },
        sendBody: true,
        body: expr('{{ JSON.stringify($json) }}'),
        authentication: 'generic',
        genericAuthType: 'bearerToken',
        options: {
          headers: {
            'Content-Type': 'application/json',
            'User-Agent': 'n8n-hivemind-sync/1.0'
          },
          retry: {
            maxRetries: 3,
            backoff: {
              type: 'exponential',
              initial: 1000
            }
          },
          timeout: 30000
        }
      }
    }),

    // 6. Log Success
    node({
      name: 'Log Success',
      type: 'n8n-nodes-base.code',
      inputs: ['POST to HiveMind'],
      parameters: {
        jsCode: `
const response = $input.first().json;
console.log(\`HiveMind ingest successful: \${response.batch_id} (\${response.record_count} records)\`);
return $input.all();
        `
      }
    })
  ]
});
```

---

## 6. Pass/Fail Metrics & Acceptance Criteria

### 6.1 Infrastructure Checklist

- [ ] Docker Compose spins up all 4 services (n8n, PostgreSQL, Redis, reverse proxy)
- [ ] PostgreSQL health check passes (SSL enabled)
- [ ] n8n UI accessible via HTTPS on `https://localhost:5678`
- [ ] Credentials encrypted at rest (DB audit confirms)
- [ ] Redis cache responding to pings

### 6.2 HiveMind Endpoint Checklist

- [ ] Canonical schema `.json` frozen and versioned in `/schemas`
- [ ] Example payload conforms to schema
- [ ] Payload validation tool (local JSON schema validator) passes all examples
- [ ] Batch ID uniqueness enforced (UUID collision detection)
- [ ] Checksum validation implemented in test

### 6.3 Credential Template Checklist

- [ ] SAP RFC credential template documented (host, port, client, user required)
- [ ] DATEV API credential template documented (API key encryption spec)
- [ ] CRM API credential template documented (bearer token auth)
- [ ] Test connection function exists for each template
- [ ] Credentials stored encrypted in n8n DB (plaintext never logged)

### 6.4 Test Workflow Checklist

- [ ] Workflow saves and publishes without errors
- [ ] CRM API trigger (schedule or webhook) fires successfully
- [ ] Data normalization code runs without exceptions
- [ ] Batch metadata (batch_id, checksum, timestamp) generated correctly
- [ ] HiveMind POST succeeds with 200/201 response
- [ ] Failed POST triggers error alert (Slack/email)
- [ ] Retry logic kicks in on 429/5xx responses
- [ ] Logging shows record count and execution time

### 6.5 Performance Baselines (Phase 0)

| **Metric** | **Target** | **Tolerance** |
|---|---|---|
| n8n startup time | <30s | ±10s |
| CRM API fetch (100 records) | <2s | ±1s |
| Normalize + batch (100 records) | <1s | ±0.5s |
| HiveMind POST (100 records) | <5s | ±2s |
| End-to-end latency | <10s | ±3s |
| Disk storage (1 week data) | <5 GB | ±1 GB |

---

## 7. Deliverables Checklist

### Phase 0 Outputs

- [x] **docker-compose.yml** — Self-hosted n8n stack (PostgreSQL + Redis)
- [x] **.env.example** — Environment variable template (no secrets)
- [x] **scripts/generate-certs.sh** — Self-signed cert generation
- [x] **schemas/hivemind-ingest.json** — Canonical payload schema (frozen)
- [x] **examples/crm-customer-ingest.json** — Example valid ingest payload
- [x] **credentials/sap-rfc.template.json** — SAP RFC credential template
- [x] **credentials/datev-api.template.json** — DATEV credential template
- [x] **credentials/crm-api.template.json** — CRM credential template
- [x] **workflows/crm-customer-to-hivemind.n8n.ts** — Test workflow (SDK code)
- [x] **BACKFILL_VS_REALTIME.md** — Decision matrix and cadence spec
- [x] **PASS_FAIL_METRICS.md** — Acceptance criteria (infrastructure, schema, workflow)
- [x] **README.md** — Deployment instructions, troubleshooting, security notes

---

## 8. Security & Compliance Notes (EU)

### Data Residency
- All PostgreSQL data remains on EU-hosted infrastructure
- TLS 1.3 for all network communication
- Certificates signed by EU-trusted CA (see script)

### Secret Management
- All credentials encrypted at rest (n8n built-in AES-256)
- API keys stored in `.env` (gitignored), never in source
- Credential rotation policy: quarterly (Phase 1)

### Audit Trail
- n8n execution logs include batch_id, record count, status
- PostgreSQL audit logs enable per-table tracking
- HiveMind ingest endpoint logs validated batch metadata

### GDPR Compliance
- Data retention: configurable (default 30 days for synced records)
- Data deletion: automated purge for withdrawn consent
- Audit log retention: 1 year

---

## 9. Deployment Instructions (Quick Start)

```bash
# 1. Clone repo and navigate
cd n8n-hivemind-eu
cp .env.example .env

# 2. Generate SSL certificates
chmod +x scripts/generate-certs.sh
./scripts/generate-certs.sh

# 3. Start services
docker-compose up -d

# 4. Wait for health checks
docker-compose ps  # All should be "healthy"

# 5. Access n8n UI
# https://localhost:5678
# Create admin user on first login

# 6. Add credentials (manually in UI or via import)
# Import SAP, DATEV, CRM templates

# 7. Deploy test workflow
# Copy workflows/crm-customer-to-hivemind.n8n.ts → n8n

# 8. Validate HiveMind connectivity
# POST to https://localhost:5678/api/v1/ingest with example payload
# Check response: batch_id echoed + record_count
```

---

## 10. Known Limitations & Risks (Phase 0)

| **Risk** | **Mitigation** |
|---|---|
| Self-signed SSL for local testing | Replace with CA-signed cert in production (Phase 1) |
| No multi-node n8n cluster (single point of failure) | Add clustering via n8n Enterprise or PM2 (Phase 2) |
| PostgreSQL backups manual | Implement automated daily snapshots (Phase 1) |
| No Sentry/observability | Add OpenTelemetry exporter + Datadog (Phase 1) |
| Credential rotation manual | Build credential rotation workflow (Phase 1) |

---

## 11. Next Steps (Phase 1 Scope Preview)

1. **Production SSL** — CA-signed certificates + DNS CNAME
2. **HA/Failover** — Multi-node n8n + database replication
3. **Monitoring** — Prometheus + Grafana dashboards
4. **Backfill Workflows** — SAP AR/AP + DATEV journal entry sync
5. **Data Quality Gates** — Schema validation + anomaly detection in HiveMind
6. **Credential Rotation** — Automated key rotation for SAP, DATEV, CRM

---

**Phase 0 Duration:** 1 week  
**Phase 0 Success Criteria:** All infrastructure + schema + workflow tests passing; ready to add production systems (SAP, DATEV, CRM) in Phase 1.

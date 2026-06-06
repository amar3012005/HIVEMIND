# Phase 0: Executable Checklist

**Duration:** 1 week | **Status:** Planning → Execution  
**Owner:** DevOps + Integration Lead | **Reviewed:** [Date]

---

## Week 1: Infrastructure & Foundation

### Day 1: Docker & Infrastructure (4 hours)

**Goal:** Spinning n8n stack on localhost with persistence

- [ ] **Init Repo Structure**
  - `mkdir -p docker/postgres docker/n8n docker/redis scripts workflows schemas credentials/templates examples`
  - `touch .env.example .dockerignore docker-compose.yml`

- [ ] **Write docker-compose.yml**
  - [ ] PostgreSQL service (15-alpine, 5432)
  - [ ] n8n service (depends_on postgres)
  - [ ] Redis service (6379, optional queue/cache)
  - [ ] All with health checks
  - [ ] Volumes for persistence
  - [ ] Network bridge (n8n_network)

- [ ] **Create .env.example**
  - [ ] DB credentials (non-production defaults)
  - [ ] n8n config (host, port, encryption key)
  - [ ] HiveMind API URL + key placeholders
  - [ ] Per-system credential vars (SAP, DATEV, CRM)

- [ ] **Generate SSL Certs**
  - [ ] Run `scripts/generate-certs.sh`
  - [ ] Verify `certs/server.crt` + `certs/server.key` exist
  - [ ] Update `.dockerignore` to exclude secrets

- [ ] **Test Startup**
  - [ ] `docker-compose up -d`
  - [ ] `docker-compose ps` — all services green
  - [ ] `docker-compose logs n8n` — no errors
  - [ ] Browser: `https://localhost:5678` (self-signed warning OK)
  - [ ] n8n admin user creation UI visible

**Acceptance:** n8n UI loads, PostgreSQL healthy, no crashes in first 5 mins

---

### Day 2: HiveMind Schema & Validation (3 hours)

**Goal:** Frozen canonical payload schema + local validator

- [ ] **Create schemas/hivemind-ingest.json**
  - [ ] JSON Schema Draft-07
  - [ ] Required: source_system, data_type, records, metadata
  - [ ] Records array with id, data, source_id, timestamp, fingerprint
  - [ ] Metadata with batch_id, timestamp, record_count, ingestion_mode
  - [ ] Enum constraints: source_system (SAP, DATEV, CRM), data_type (customer, invoice, etc.)

- [ ] **Create examples/crm-customer-ingest.json**
  - [ ] 1 sample customer record
  - [ ] Valid SHA256 fingerprint
  - [ ] Valid batch_id (UUID or timestamp-based)
  - [ ] Checksum calculation documented

- [ ] **Schema Validation Tool**
  - [ ] Copy `schemas/validate.js` (Node.js + ajv validator)
  - [ ] Test: `node schemas/validate.js examples/crm-customer-ingest.json`
  - [ ] Expected output: "✓ Payload valid"

- [ ] **Version Control**
  - [ ] `git add schemas/` + `git commit -m "feat(schema): canonical hivemind ingest payload v1.0"`

**Acceptance:** Schema validates example payload; schema file marked immutable (v1.0)

---

### Day 3: Credential Templates (2.5 hours)

**Goal:** Encrypted credential patterns for SAP, DATEV, CRM

- [ ] **SAP RFC Template** (`credentials/sap-rfc.template.json`)
  - [ ] Properties: host, port, client, user, password, language, use_ssl
  - [ ] Test function: STFC_CONNECTION
  - [ ] Encryption flag on password field

- [ ] **DATEV API Template** (`credentials/datev-api.template.json`)
  - [ ] Properties: api_url, api_key, tenant_id, environment, timeout_ms
  - [ ] Test endpoint: `/api/v1/organizations`
  - [ ] Encryption flag on api_key

- [ ] **CRM API Template** (`credentials/crm-api.template.json`)
  - [ ] Properties: api_url, api_key, org_id, api_version
  - [ ] Test endpoint: `/api/v2/accounts`
  - [ ] Encryption flag on api_key

- [ ] **n8n Credential Docs**
  - [ ] Each template has "setup instructions" (e.g., "To get SAP RFC credentials: SAP Basis → PFCG → STFC_CONNECTION role")

**Acceptance:** All 3 templates in `credentials/` with encryption specs; SAP test function documented

---

### Day 4: Test Workflow & n8n SDK (4 hours)

**Goal:** CRM customer sync workflow coded, validated, deployed to n8n

- [ ] **Read n8n SDK Reference**
  - [ ] `get_sdk_reference()` — patterns, expressions, functions
  - [ ] `get_suggested_nodes(["data_transformation", "notification"])` — recommended nodes

- [ ] **Discover Nodes**
  - [ ] `search_nodes(["schedule trigger", "http request", "code", "merge"])`
  - [ ] Note discriminators (resource, operation, mode)

- [ ] **Get Type Definitions**
  - [ ] `get_node_types()` for all 5 nodes (Schedule, HTTP, Code x2, HTTP)
  - [ ] Verify parameter names: `url`, `method`, `authentication`, `jsCode`, etc.

- [ ] **Write Workflow Code**
  - [ ] `workflows/crm-customer-to-hivemind.n8n.ts`
  - [ ] 6 nodes: Schedule → Fetch CRM → Normalize → Batch → POST HiveMind → Log
  - [ ] Error handling on HTTP nodes (retry 3x exponential)

- [ ] **Validate Workflow**
  - [ ] `validate_workflow()` — no syntax errors
  - [ ] Fix any parameter mismatches

- [ ] **Deploy to n8n**
  - [ ] `create_workflow_from_code()` with validated code
  - [ ] Workflow ID returned (note for next step)

- [ ] **Test Execution (Manual Trigger)**
  - [ ] n8n UI: "Execute Workflow" button
  - [ ] Mock CRM data (or real test account)
  - [ ] Expected: JSON payload built, POST sent, response logged
  - [ ] Check: Batch ID in logs, record count matches

**Acceptance:** Workflow executes end-to-end without errors; HiveMind POST returns 200

---

### Day 5: Integration Tests & Performance Baseline (3.5 hours)

**Goal:** Validate schema + workflow + metrics

- [ ] **Schema Validation**
  - [ ] Run `node schemas/validate.js examples/crm-customer-ingest.json` ✓
  - [ ] Run validator on workflow output (captured from n8n logs)
  - [ ] Expected: All payloads pass schema

- [ ] **HiveMind Connectivity**
  - [ ] POST `examples/crm-customer-ingest.json` to HiveMind `/v1/ingest` (manual curl)
  - [ ] Auth header: `Authorization: Bearer ${HIVEMIND_API_KEY}`
  - [ ] Expected response: `{ batch_id: "...", record_count: 1, status: "ingested" }`

- [ ] **Workflow Metrics**
  - [ ] Run workflow 3 times, measure execution time
  - [ ] Avg latency per step (capture from n8n logs):
    - [ ] CRM fetch: <2s
    - [ ] Normalize: <1s
    - [ ] Batch: <0.5s
    - [ ] POST: <5s
    - [ ] Total: <10s

- [ ] **Error Handling Test**
  - [ ] Simulate 429 (rate limit) response from HiveMind
  - [ ] Verify retry logic triggers (3 attempts)
  - [ ] Check logs for backoff delay (exponential)

- [ ] **Database Persistence**
  - [ ] Stop n8n: `docker-compose down`
  - [ ] Start n8n: `docker-compose up -d`
  - [ ] Verify execution history + workflow still exist

**Acceptance:** Metrics documented; schema passes; HiveMind connectivity confirmed

---

### Day 6: Documentation & Deployment Guide (2 hours)

**Goal:** README + quick-start instructions

- [ ] **README.md**
  - [ ] Overview: "Self-hosted n8n + HiveMind EU integration"
  - [ ] Quick start: `cp .env.example .env && docker-compose up -d`
  - [ ] Services table: PostgreSQL, n8n, Redis, ports
  - [ ] Credential setup walkthrough (SAP RFC, DATEV, CRM)
  - [ ] Workflow deployment steps
  - [ ] Troubleshooting: "n8n won't start", "HiveMind 401", etc.

- [ ] **DEPLOYMENT.md**
  - [ ] Pre-req checklist (Docker, Docker Compose versions)
  - [ ] Step-by-step deploy from scratch
  - [ ] SSL cert setup (production CA vs self-signed)
  - [ ] Database initialization
  - [ ] Health checks

- [ ] **BACKFILL_VS_REALTIME.md**
  - [ ] Decision matrix (SAP, DATEV, CRM workflows)
  - [ ] Cadence rationale (backfill daily 2 AM, real-time webhooks)
  - [ ] Volume estimates per system

- [ ] **Version Control**
  - [ ] `git add PHASE_0_*.md README.md docker-compose.yml scripts/ schemas/ credentials/ workflows/ examples/`
  - [ ] `git commit -m "feat(phase0): self-hosted n8n + hivemind foundation (docker, schema, crm-sync workflow)"`

**Acceptance:** All docs merged to main; README deployment instructions tested once manually

---

### Day 7: UAT & Sign-Off (1 day buffer)

**Goal:** Acceptance criteria verified; ready for Phase 1

- [ ] **Infrastructure Checklist**
  - [ ] ✓ Docker Compose all services healthy
  - [ ] ✓ PostgreSQL SSL enabled
  - [ ] ✓ n8n HTTPS accessible
  - [ ] ✓ Redis responding
  - [ ] ✓ Credentials encrypted in DB

- [ ] **Schema Checklist**
  - [ ] ✓ Canonical schema frozen (v1.0)
  - [ ] ✓ Example payload conforms
  - [ ] ✓ Validator tool functional
  - [ ] ✓ Batch ID uniqueness spec documented

- [ ] **Credential Checklist**
  - [ ] ✓ SAP RFC template with test function
  - [ ] ✓ DATEV API template with test endpoint
  - [ ] ✓ CRM API template with test endpoint
  - [ ] ✓ All encrypted at rest

- [ ] **Workflow Checklist**
  - [ ] ✓ CRM sync workflow publishes + executes
  - [ ] ✓ Data normalization runs
  - [ ] ✓ Batch metadata generated (batch_id, checksum)
  - [ ] ✓ HiveMind POST succeeds
  - [ ] ✓ Retry logic works (tested on 429)
  - [ ] ✓ Logging shows record count + execution time

- [ ] **Performance Checklist**
  - [ ] ✓ n8n startup: <30s
  - [ ] ✓ CRM fetch: <2s (100 records)
  - [ ] ✓ Normalize: <1s
  - [ ] ✓ POST: <5s
  - [ ] ✓ End-to-end: <10s

- [ ] **Sign-Off**
  - [ ] [ ] DevOps lead: _____________________  Date: _________
  - [ ] [ ] Integration lead: _____________________  Date: _________
  - [ ] [ ] Security review: _____________________  Date: _________

---

## Delivery Artifacts

### Code
- `docker-compose.yml` — self-hosted stack
- `scripts/generate-certs.sh` — SSL cert automation
- `workflows/crm-customer-to-hivemind.n8n.ts` — test workflow (SDK)
- `schemas/validate.js` — JSON schema validator

### Config
- `.env.example` — environment variable template
- `credentials/*.template.json` — SAP, DATEV, CRM credential patterns

### Data
- `schemas/hivemind-ingest.json` — canonical payload schema
- `examples/crm-customer-ingest.json` — valid example payload

### Docs
- `README.md` — overview + quick-start
- `DEPLOYMENT.md` — step-by-step deploy
- `BACKFILL_VS_REALTIME.md` — cadence decision matrix
- `PHASE_0_FOUNDATION.md` — full architecture + specs
- `PHASE_0_CHECKLIST.md` — this file

---

## Risks & Mitigations

| **Risk** | **Probability** | **Impact** | **Mitigation** |
|---|---|---|---|
| SSL cert generation fails | Low | High | Pre-test `generate-certs.sh` on Day 1 |
| PostgreSQL init hangs | Low | High | Increase timeout; check logs |
| n8n won't reach HiveMind API | Medium | High | Test connectivity from n8n container (`curl -H "Auth..."`) |
| CRM API credentials wrong | Medium | Medium | Validate creds in UI before workflow deploy |
| Workflow code syntax errors | Medium | Low | Use `validate_workflow()` before create |

---

## Escalation Path

- **Docker issues:** → Docker community docs + ensure `docker-compose version >= 2.0`
- **n8n SDK issues:** → n8n docs + search existing workflows in n8n cloud
- **HiveMind API 401:** → Check `HIVEMIND_API_KEY` in `.env`; validate Bearer format
- **PostgreSQL SSL:** → Check cert paths in `docker-compose.yml` volume mounts

---

**Phase 0 Complete:** Infrastructure running, schema frozen, test workflow executing, metrics documented.  
**Ready for Phase 1:** SAP/DATEV/CRM backfill workflows + HA setup + monitoring.

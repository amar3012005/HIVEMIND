# HIVE-MIND Disaster Recovery Plan
## EU Sovereign Deployment - GDPR, NIS2, DORA Compliant

**Document Version:** 1.0.0  
**Last Updated:** March 9, 2026  
**Classification:** Internal - Operations  
**Review Frequency:** Quarterly

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Recovery Objectives](#2-recovery-objectives)
3. [Infrastructure Overview](#3-infrastructure-overview)
4. [Disaster Scenarios](#4-disaster-scenarios)
5. [Recovery Procedures](#5-recovery-procedures)
6. [Communication Plan](#6-communication-plan)
7. [Testing & Validation](#7-testing--validation)
8. [Appendices](#8-appendices)

---

## 1. Executive Summary

This document defines the disaster recovery procedures for HIVE-MIND's EU sovereign infrastructure. The plan ensures business continuity in the event of infrastructure failures, data corruption, security incidents, or regional outages.

### 1.1 Scope

- **Primary Infrastructure:** Hetzner (DE/FI), Scaleway (FR), OVHcloud (FR)
- **Services Covered:** API, PostgreSQL, Qdrant, Redis, Traefik
- **Compliance:** GDPR Article 32, NIS2 Article 21, DORA Article 11

### 1.2 Key Contacts

| Role | Name | Contact | Escalation |
|------|------|---------|------------|
| Incident Commander | On-call Lead | +XX-XXX-XXX-XXX | Immediate |
| Database Admin | DBA Team | dba@hivemind.io | 15 min |
| Security Officer | CISO | security@hivemind.io | Immediate |
| Communications | PR Team | pr@hivemind.io | 30 min |

---

## 2. Recovery Objectives

### 2.1 Recovery Time Objective (RTO)

| Service | RTO | Priority |
|---------|-----|----------|
| API Gateway (Traefik) | 15 minutes | Critical |
| Core API | 30 minutes | Critical |
| PostgreSQL Database | 4 hours | Critical |
| Qdrant Vector DB | 2 hours | High |
| Redis Cache | 30 minutes | High |
| Monitoring Stack | 4 hours | Medium |
| Grafana Dashboards | 8 hours | Low |

### 2.2 Recovery Point Objective (RPO)

| Data Type | RPO | Backup Frequency |
|-----------|-----|------------------|
| PostgreSQL | 24 hours | Daily + WAL archiving |
| Qdrant Vectors | 24 hours | Daily snapshots |
| Redis Sessions | 1 hour | AOF persistence |
| Configuration | 7 days | Git version control |
| Logs | 30 days | Continuous shipping |

### 2.3 Maximum Tolerable Downtime (MTD)

| Service | MTD |
|---------|-----|
| API | 24 hours |
| Database | 48 hours |
| Full Platform | 72 hours |

---

## 3. Infrastructure Overview

### 3.1 Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│                    EU Sovereign Cloud                           │
│                                                                 │
│  ┌─────────────┐    ┌─────────────┐    ┌─────────────┐         │
│  │  Hetzner    │    │  Scaleway   │    │  OVHcloud   │         │
│  │  (Compute)  │    │ (PostgreSQL)│    │  (HSM/KMS)  │         │
│  │  DE / FI    │    │    FR-Paris │    │    FR       │         │
│  └──────┬──────┘    └──────┬──────┘    └──────┬──────┘         │
│         │                  │                  │                 │
│         └──────────────────┼──────────────────┘                 │
│                            │                                    │
│              ┌─────────────▼─────────────┐                      │
│              │   Traefik Gateway         │                      │
│              │   (TLS Termination)       │                      │
│              └─────────────┬─────────────┘                      │
│                            │                                    │
│     ┌──────────────────────┼──────────────────────┐             │
│     │                      │                      │             │
│     ▼                      ▼                      ▼             │
│ ┌─────────┐          ┌─────────┐          ┌─────────┐           │
│ │  Core   │          │ Qdrant  │          │  Redis  │           │
│ │  API    │          │ Vectors │          │  Cache  │           │
│ └────┬────┘          └────┬────┘          └────┬────┘           │
│      │                    │                    │                │
│      └────────────────────┼────────────────────┘                │
│                           │                                     │
│                ┌──────────▼──────────┐                          │
│                │  PostgreSQL + AGE   │                          │
│                │  (LUKS2 Encrypted)  │                          │
│                └─────────────────────┘                          │
└─────────────────────────────────────────────────────────────────┘
```

### 3.2 Backup Locations

| Backup Type | Primary Location | Secondary Location | Retention |
|-------------|------------------|-------------------|-----------|
| PostgreSQL Daily | Scaleway S3 (FR) | Hetzner Storage Box | 30 days |
| PostgreSQL Weekly | Scaleway S3 (FR) | Hetzner Storage Box | 4 weeks |
| PostgreSQL Monthly | Scaleway S3 (FR) | Hetzner Storage Box | 12 months |
| Qdrant Snapshots | Local NVMe | Scaleway S3 | 7 days |
| Configuration | GitHub Private | Local encrypted | Indefinite |

---

## 4. Disaster Scenarios

### 4.1 Scenario 1: Database Corruption

**Severity:** Critical  
**RTO:** 4 hours  
**RPO:** 24 hours

**Symptoms:**
- PostgreSQL fails health checks
- Application errors: "connection refused", "database does not exist"
- Data inconsistencies reported by users

**Detection:**
- Prometheus alert: `PostgreSQLDown`
- Grafana dashboard: Database connections = 0
- API error rate spike

### 4.2 Scenario 2: Infrastructure Loss (Region Outage)

**Severity:** Critical  
**RTO:** 8 hours  
**RPO:** 24 hours

**Symptoms:**
- Complete loss of connectivity to provider
- All services unreachable
- DNS resolution failures

**Detection:**
- Blackbox exporter alerts
- External monitoring (Pingdom, Uptime Robot)
- Provider status page

### 4.3 Scenario 3: Security Breach / Data Compromise

**Severity:** Critical  
**RTO:** Immediate containment, 24h recovery  
**RPO:** Point of breach identification

**Symptoms:**
- Unauthorized access detected
- Unusual data exfiltration patterns
- GDPR breach indicators

**Detection:**
- SIEM alerts
- Traefik access log anomalies
- Database audit log alerts

### 4.4 Scenario 4: Ransomware Attack

**Severity:** Critical  
**RTO:** 24 hours  
**RPO:** Last known good backup

**Symptoms:**
- Encrypted files on storage volumes
- Ransom notes in file systems
- Unusual encryption processes

### 4.5 Scenario 5: Application Bug / Bad Deployment

**Severity:** High  
**RTO:** 30 minutes  
**RPO:** Zero (rollback)

**Symptoms:**
- Error rate spike after deployment
- Specific endpoint failures
- User-reported issues

---

## 5. Recovery Procedures

### 5.1 Database Corruption Recovery

#### Step 1: Assess Damage (15 minutes)

```bash
# Check PostgreSQL status
docker exec hivemind-postgres pg_isready -U hivemind

# Check database accessibility
docker exec hivemind-postgres psql -U hivemind -d hivemind -c "SELECT 1;"

# Review PostgreSQL logs
docker logs hivemind-postgres --tail 100

# Check for corruption indicators
docker exec hivemind-postgres psql -U hivemind -d hivemind -c "
    SELECT schemaname, tablename 
    FROM pg_tables 
    WHERE schemaname = 'public';
"
```

#### Step 2: Stop Affected Services (5 minutes)

```bash
# Stop API to prevent further damage
docker stop hivemind-api

# Stop backup jobs
docker stop hivemind-backup
```

#### Step 3: Restore from Backup (2-4 hours)

```bash
# Set environment variables
export POSTGRES_PASSWORD="<secure-password>"
export BACKUP_ENCRYPTION_KEY="<encryption-key>"
export RESTORE_FROM="latest"

# Run restore script
./scripts/restore-postgres.sh --latest

# Verify restore
docker exec hivemind-postgres pg_isready -U hivemind
docker exec hivemind-postgres psql -U hivemind -d hivemind -c "SELECT COUNT(*) FROM users;"
```

#### Step 4: Restart Services (10 minutes)

```bash
# Start API
docker start hivemind-api

# Verify health
curl -f http://localhost:3000/health

# Check Grafana for metrics
```

### 5.2 Infrastructure Loss Recovery

#### Step 1: Activate DR Site (30 minutes)

```bash
# Clone infrastructure to secondary region
cd /path/to/hivemind-infra

# Update environment for DR region
export DOMAIN_NAME="hivemind.io"
export CLOUDFLARE_DNS_API_TOKEN="<token>"
export SCW_ACCESS_KEY="<key>"
export SCW_SECRET_KEY="<secret>"

# Deploy to DR infrastructure
docker-compose -f docker-compose.production.yml up -d
```

#### Step 2: Restore Database (2-4 hours)

```bash
# Download latest backup from S3
aws s3 cp s3://hivemind-backups/daily/ \
    ./backups/daily/ \
    --recursive \
    --endpoint-url https://s3.fr-par.scw.cloud

# Restore database
./scripts/restore-postgres.sh --latest --s3
```

#### Step 3: Update DNS (5 minutes)

```bash
# Update DNS records via Cloudflare API
curl -X PUT "https://api.cloudflare.com/client/v4/zones/<zone-id>/dns_records/<record-id>" \
    -H "Authorization: Bearer <token>" \
    -H "Content-Type: application/json" \
    --data '{"content":"<new-ip>"}'
```

### 5.3 Security Breach Response

#### Step 1: Immediate Containment (5 minutes)

```bash
# Isolate affected containers
docker network disconnect hivemind-network hivemind-api

# Revoke all active sessions
docker exec hivemind-redis redis-cli FLUSHDB

# Rotate all credentials
# 1. Database password
# 2. Redis password
# 3. API keys
# 4. HSM keys
```

#### Step 2: Forensic Analysis

```bash
# Preserve logs for investigation
docker logs hivemind-traefik > /forensics/traefik-$(date +%Y%m%d-%H%M%S).log
docker logs hivemind-api > /forensics/api-$(date +%Y%m%d-%H%M%S).log
docker logs hivemind-postgres > /forensics/postgres-$(date +%Y%m%d-%H%M%S).log

# Export audit logs
docker exec hivemind-postgres psql -U hivemind -d hivemind \
    -c "COPY audit_logs TO '/backups/audit_logs_$(date +%Y%m%d).csv' WITH CSV HEADER;"
```

#### Step 3: GDPR Breach Notification (72 hours)

1. **Hour 0-24:** Internal investigation
2. **Hour 24-48:** Impact assessment
3. **Hour 48-72:** Regulatory notification

```bash
# Generate breach report template
cat > /forensics/breach-report.md << EOF
# Security Breach Report

## Incident Details
- Date/Time: $(date -u +%Y-%m-%dT%H:%M:%SZ)
- Severity: Critical
- Data Categories Affected: [TO BE DETERMINED]
- Number of Users Affected: [TO BE DETERMINED]

## Immediate Actions Taken
1. [Action 1]
2. [Action 2]

## Root Cause Analysis
[TO BE COMPLETED]

## Remediation Plan
[TO BE COMPLETED]
EOF
```

### 5.4 Bad Deployment Rollback

#### Step 1: Identify Bad Version (5 minutes)

```bash
# Check current version
docker inspect hivemind-api | grep Image

# Review recent deployments
kubectl rollout history deployment/hivemind-api -n hivemind
```

#### Step 2: Rollback (10 minutes)

```bash
# Docker Compose rollback
docker-compose -f docker-compose.production.yml pull hivemind/core:previous-tag
docker-compose -f docker-compose.production.yml up -d hivemind-api

# Kubernetes rollback
kubectl rollout undo deployment/hivemind-api -n hivemind
```

#### Step 3: Verify (5 minutes)

```bash
# Health check
curl -f http://localhost:3000/health

# Smoke tests
./scripts/smoke-tests.sh
```

---

## 6. Communication Plan

### 6.1 Internal Communication

| Time | Action | Audience |
|------|--------|----------|
| T+0 | Incident detected | On-call team |
| T+15m | Initial assessment | Engineering team |
| T+30m | Status update | All staff |
| T+1h | Detailed briefing | Leadership |
| T+4h | Resolution update | All staff |

### 6.2 External Communication

| Time | Action | Audience |
|------|--------|----------|
| T+1h | Status page update | Public |
| T+4h | Customer notification | Affected users |
| T+24h | Detailed post-mortem | Public |
| T+72h | GDPR notification (if applicable) | Regulators |

### 6.3 Communication Templates

#### Status Page Update

```
# Service Disruption - [DATE]

We are currently experiencing issues with [SERVICE]. 
Our team is investigating and working on a resolution.

Last updated: [TIME]
Next update: [TIME + 1 hour]
```

#### Customer Notification

```
Subject: Important: Service Update from HIVE-MIND

Dear [Customer],

We are writing to inform you of a service disruption affecting [SERVICE].

Impact: [Description]
Current Status: [Investigating/Identified/Resolved]
Expected Resolution: [Time]

We apologize for any inconvenience and appreciate your patience.

Best regards,
HIVE-MIND Team
```

---

## 7. Testing & Validation

### 7.1 DR Test Schedule

| Test Type | Frequency | Duration | Owner |
|-----------|-----------|----------|-------|
| Backup Verification | Daily | Automated | System |
| Restore Test | Monthly | 4 hours | DBA |
| Full DR Drill | Quarterly | 8 hours | Operations |
| Tabletop Exercise | Monthly | 2 hours | Security |

### 7.2 Backup Verification

```bash
#!/bin/bash
# Daily backup verification script

# Verify latest backup exists
LATEST=$(find /backups/daily -name "*.sql.gz*" -printf '%T@ %p\n' | sort -rn | head -1)
if [[ -z "$LATEST" ]]; then
    echo "CRITICAL: No backups found!"
    exit 1
fi

# Verify checksum
BACKUP_FILE=$(echo "$LATEST" | cut -d' ' -f2-)
if ! sha256sum -c "${BACKUP_FILE}.sha256"; then
    echo "CRITICAL: Checksum verification failed!"
    exit 1
fi

# Test restore to temporary database
echo "Testing restore to temporary database..."
# (Full restore test in monthly procedure)

echo "Backup verification passed"
```

### 7.3 Monthly Restore Test

```bash
#!/bin/bash
# Monthly restore test procedure

# Create test database
docker run -d --name test-restore \
    -e POSTGRES_PASSWORD=test \
    -e POSTGRES_DB=test_restore \
    postgres:15-alpine

# Wait for database
sleep 10

# Restore to test database
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5433
export POSTGRES_DB=test_restore
export POSTGRES_PASSWORD=test

./scripts/restore-postgres.sh --latest --dry-run

# Verify test restore
docker exec test-restore psql -U postgres -d test_restore \
    -c "SELECT COUNT(*) FROM users;"

# Cleanup
docker stop test-restore
docker rm test-restore
```

### 7.4 Quarterly DR Drill

1. **Preparation (Week 1)**
   - Schedule maintenance window
   - Notify stakeholders
   - Prepare test environment

2. **Execution (Week 2)**
   - Simulate disaster scenario
   - Execute recovery procedures
   - Document timing and issues

3. **Review (Week 3)**
   - Analyze results
   - Update procedures
   - Train team on lessons learned

---

## 8. Appendices

### 8.1 Environment Variables Reference

```bash
# Database
POSTGRES_HOST=postgres
POSTGRES_PORT=5432
POSTGRES_DB=hivemind
POSTGRES_USER=hivemind
POSTGRES_PASSWORD=<secure>

# Backup
BACKUP_DIR=/backups
BACKUP_ENCRYPTION_KEY=<secure>
BACKUP_RETENTION_DAYS=30
BACKUP_RETENTION_WEEKS=4
BACKUP_RETENTION_MONTHS=12

# S3 (Scaleway)
S3_BUCKET=hivemind-backups
S3_ENDPOINT=s3.fr-par.scw.cloud
S3_REGION=fr-par
S3_ACCESS_KEY=<secure>
S3_SECRET_KEY=<secure>
```

### 8.2 Recovery Command Quick Reference

```bash
# Check service health
docker-compose -f docker-compose.production.yml ps

# View logs
docker logs hivemind-<service> --tail 100

# Restart service
docker-compose -f docker-compose.production.yml restart <service>

# Backup now
./scripts/backup-postgres.sh

# Restore latest
./scripts/restore-postgres.sh --latest

# Database connection test
docker exec hivemind-postgres pg_isready -U hivemind
```

### 8.3 Compliance Checklist

- [ ] Backup encryption verified (AES-256-CBC)
- [ ] LUKS2 encryption active on volumes
- [ ] TLS 1.3 enforced on all endpoints
- [ ] Access logs retained for 7 years
- [ ] GDPR breach notification procedure documented
- [ ] NIS2 incident reporting contacts defined
- [ ] DORA operational resilience tested

### 8.4 Document History

| Version | Date | Author | Changes |
|---------|------|--------|---------|
| 1.0.0 | 2026-03-09 | DevOps Team | Initial release |

---

**END OF DOCUMENT**

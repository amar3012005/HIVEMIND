# HIVE-MIND Coolify Deployment Guide

## Overview

This guide covers deploying HIVE-MIND to [Coolify](https://coolify.io/) on EU sovereign cloud infrastructure (Hetzner, Scaleway, OVHcloud).

## Prerequisites

- Coolify instance running on EU sovereign cloud
- Docker installed locally (for building)
- Git repository access
- API keys for:
  - Groq (inference)
  - Mistral AI (embeddings)
  - Database (PostgreSQL)
  - Vector store (Qdrant)

## Quick Start

### 1. Clone and Configure

```bash
git clone https://github.com/your-org/hivemind.git
cd hivemind

# Copy environment template
cp .env.coolify .env.coolify.local

# Edit with your values
nano .env.coolify.local
```

### 2. Required Environment Variables

```bash
# Core Application
NODE_ENV=production
PORT=3000

# Database (PostgreSQL + Apache AGE)
DATABASE_URL=postgresql://user:pass@host:5432/hivemind?schema=public

# Vector Store (Qdrant)
QDRANT_URL=https://your-cluster.qdrant.io:6333
QDRANT_API_KEY=your-qdrant-api-key

# LLM APIs
GROQ_API_KEY=your-groq-api-key
MISTRAL_API_KEY=your-mistral-api-key

# Security (generate with openssl rand -hex 32)
API_MASTER_KEY=your-master-key
SESSION_SECRET=your-session-secret
HIVEMIND_MASTER_API_KEY=hmk_live_your-master-key
HIVEMIND_ADMIN_SECRET=your-admin-secret

# EU Sovereign Settings
EU_REGION=eu-central-1
DATA_RESIDENCY=EU
GDPR_MODE=true
```

### 3. Deploy to Coolify

#### Option A: Automated Deployment Script

```bash
# Make script executable
chmod +x scripts/deploy-coolify.sh

# Deploy to production
./scripts/deploy-coolify.sh production

# Or deploy to staging
./scripts/deploy-coolify.sh staging
```

#### Option B: Manual Coolify Configuration

1. **Log in to Coolify Dashboard**
   - Navigate to your Coolify instance
   - Create a new "Application"

2. **Source Configuration**
   - **Repository**: `https://github.com/your-org/hivemind`
   - **Branch**: `main` (or `production`)
   - **Build Command**: `docker build -f Dockerfile.production -t hivemind .`
   - **Port**: `3000`

3. **Environment Variables**
   - Import from `.env.coolify` file
   - Or add manually in Coolify UI

4. **Health Check**
   - **Path**: `/health`
   - **Interval**: `30s`
   - **Timeout**: `10s`
   - **Retries**: `3`

5. **Resource Limits** (Recommended)
   - **CPU**: 2 cores
   - **Memory**: 2GB
   - **Disk**: 10GB

6. **Domain & SSL**
   - **Domain**: Your custom domain or Coolify subdomain
   - **SSL**: Enabled (Let's Encrypt)

### 4. Database Setup

If using managed PostgreSQL:

```bash
# Run migrations
npm run db:migrate

# Seed initial data (optional)
npm run db:seed
```

If using Coolify's PostgreSQL service:

1. Add PostgreSQL service in Coolify
2. Configure `DATABASE_URL` to point to the service
3. Run migrations after deployment

### 5. Verify Deployment

```bash
# Health check
curl https://your-domain.com/health

# Expected response:
# {"ok":true,"service":"hivemind-api","port":3000}

# API test
curl -X POST https://your-domain.com/api/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer your-api-key" \
  -d '{"prompt":"Hello"}'
```

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                        Coolify                              │
│  ┌─────────────────────────────────────────────────────┐   │
│  │                  Traefik (Edge)                     │   │
│  │         SSL/TLS, Rate Limiting, Security            │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│  ┌─────────────────────────────────────────────────────┐   │
│  │              HIVE-MIND API (Node.js)                │   │
│  │         Port: 3000, Health: /health                 │   │
│  └─────────────────────────────────────────────────────┘   │
│                           │                                 │
│  ┌─────────────┐  ┌──────────────┐  ┌─────────────────┐   │
│  │ PostgreSQL  │  │    Qdrant    │  │     Redis       │   │
│  │  + AGE      │  │  (Vectors)   │  │   (Sessions)    │   │
│  └─────────────┘  └──────────────┘  └─────────────────┘   │
└─────────────────────────────────────────────────────────────┘
```

## EU Sovereign Cloud Providers

### Hetzner (Germany/Finland)

```bash
# Recommended instance: CPX31
# - 4 vCPUs (AMD EPYC)
# - 8 GB RAM
# - 160 GB NVMe
# - Location: Falkenstein (DE) or Helsinki (FI)

# Pricing: ~€12.40/month
```

### Scaleway (France)

```bash
# Recommended instance: DEV1-L
# - 4 vCPUs
# - 8 GB RAM
# - 80 GB SSD
# - Location: Paris (FR)

# Pricing: ~€15.99/month
```

### OVHcloud (France)

```bash
# Recommended instance: Advance-1
# - 4 vCPUs (Intel Xeon)
# - 8 GB RAM
# - 100 GB SSD
# - Location: Gravelines (FR)

# Pricing: ~€14.99/month
```

## Security Configuration

### SSL/TLS

Coolify automatically provisions Let's Encrypt certificates. For EU sovereign compliance:

```yaml
# Traefik labels (auto-configured by Coolify)
traefik.http.routers.hivemind.tls=true
traefik.http.routers.hivemind.tls.certresolver=letsencrypt
traefik.http.routers.hivemind.tls.options=default
```

### Security Headers

```yaml
traefik.http.middlewares.hivemind-security.headers.stsSeconds=31536000
traefik.http.middlewares.hivemind-security.headers.stsIncludeSubdomains=true
traefik.http.middlewares.hivemind-security.headers.stsPreload=true
traefik.http.middlewares.hivemind-security.headers.contentTypeNosniff=true
traefik.http.middlewares.hivemind-security.headers.browserXssFilter=true
```

### Rate Limiting

```yaml
traefik.http.middlewares.hivemind-ratelimit.ratelimit.average=100
traefik.http.middlewares.hivemind-ratelimit.ratelimit.burst=200
```

## Monitoring

### Health Endpoints

| Endpoint | Description |
|----------|-------------|
| `/health` | Basic health check |
| `/api/keys` | API key management (admin only) |

### Logs

Access logs via Coolify dashboard or CLI:

```bash
# View logs
coolify logs hivemind-api

# Follow logs
coolify logs -f hivemind-api
```

### Metrics

Enable Prometheus metrics:

```bash
# Add to environment variables
ENABLE_METRICS=true
METRICS_PORT=9090
```

## Backup & Recovery

### Automated Backups

Configure in Coolify or use the backup script:

```bash
# Run backup
./scripts/backup-postgres.sh

# Schedule with cron (daily at 2 AM)
0 2 * * * /path/to/hivemind/scripts/backup-postgres.sh
```

### Backup Configuration

```bash
# Scaleway Object Storage (EU)
SCW_ACCESS_KEY=your-access-key
SCW_SECRET_KEY=your-secret-key
BACKUP_BUCKET=hivemind-backups
BACKUP_ENCRYPTION_KEY=your-encryption-key
```

## Troubleshooting

### Common Issues

#### Container Won't Start

```bash
# Check logs
docker logs hivemind-api

# Verify environment variables
docker exec hivemind-api env | grep -E "(DATABASE|QDRANT|GROQ)"

# Test database connection
docker exec hivemind-api nc -zv postgres 5432
```

#### Health Check Failing

```bash
# Test health endpoint manually
curl -v http://localhost:3000/health

# Check if port is listening
netstat -tlnp | grep 3000
```

#### Database Connection Issues

```bash
# Verify DATABASE_URL format
# Should be: postgresql://user:pass@host:5432/db?schema=public

# Test connection from container
docker exec -it hivemind-api psql "${DATABASE_URL}" -c "SELECT 1;"
```

### Getting Help

1. Check Coolify documentation: https://coolify.io/docs/
2. Review HIVE-MIND logs in Coolify dashboard
3. Check EU sovereign compliance: `/compliance` directory
4. Contact: ops@hivemind.io

## GDPR Compliance

### Data Residency

- All data stored in EU (Germany/France)
- No data transfer outside EU
- LUKS2 encryption at rest

### User Rights

```bash
# Data export
POST /api/gdpr/export

# Data deletion
DELETE /api/gdpr/erase

# Consent management
GET /api/gdpr/consent
```

### Audit Logging

Audit logs are written to `/app/logs/audit.log`:

```json
{
  "timestamp": "2026-03-15T10:30:00Z",
  "event": "memory_created",
  "user_id": "uuid",
  "ip_address": "xxx.xxx.xxx.xxx",
  "processing_basis": "consent"
}
```

## Updates & Maintenance

### Rolling Updates

```bash
# Deploy new version
./scripts/deploy-coolify.sh production

# Coolify handles zero-downtime deployment
```

### Database Migrations

```bash
# Run migrations
npm run db:migrate

# Check migration status
npm run db:status
```

### Security Updates

```bash
# Update base image
docker pull node:20-alpine3.19

# Rebuild and redeploy
./scripts/deploy-coolify.sh production
```

## Cost Optimization

### Resource Tuning

| Component | Min | Recommended | Max |
|-----------|-----|-------------|-----|
| API | 512MB | 2GB | 4GB |
| PostgreSQL | 1GB | 4GB | 8GB |
| Qdrant | 512MB | 2GB | 4GB |
| Redis | 128MB | 256MB | 512MB |

### Auto-scaling

Configure in Coolify:

```yaml
# Horizontal scaling
replicas: 2

# Auto-scaling triggers
cpu_threshold: 70
memory_threshold: 80
```

## Support

- **Documentation**: https://docs.hivemind.io
- **Issues**: https://github.com/hivemind/issues
- **Email**: ops@hivemind.io
- **Status**: https://status.hivemind.io

---

**Last Updated**: 2026-03-15  
**Version**: 1.0.0  
**Compliance**: GDPR, NIS2, DORA

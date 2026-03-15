# HIVE-MIND Coolify Deployment Guide

Complete guide for deploying HIVE-MIND to Coolify with EU sovereign cloud compliance.

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Environment Setup](#environment-setup)
3. [Coolify Configuration](#coolify-configuration)
4. [Deployment Steps](#deployment-steps)
5. [Post-Deployment](#post-deployment)
6. [Troubleshooting](#troubleshooting)

---

## Prerequisites

### Server Requirements

| Component | Minimum | Recommended |
|-----------|---------|-------------|
| CPU | 4 cores | 8 cores |
| RAM | 8 GB | 16 GB |
| Storage | 100 GB SSD | 500 GB NVMe SSD |
| OS | Ubuntu 22.04 LTS | Ubuntu 24.04 LTS |
| Network | 1 Gbps | 10 Gbps |

### Required Services

- **Coolify v4.x** installed on your server
- **Domain name** with DNS A record pointing to your server
- **S3-compatible storage** for backups (Hetzner, Scaleway, or OVHcloud)

### API Keys Required

1. **Groq API Key** - https://console.groq.com/
2. **Mistral AI API Key** - https://console.mistral.ai/
3. **S3 Credentials** - From your EU cloud provider

---

## Environment Setup

### 1. Clone Repository

```bash
git clone https://github.com/your-org/hivemind.git
cd hivemind
```

### 2. Generate Security Keys

```bash
# Generate all required keys
export API_MASTER_KEY=$(openssl rand -hex 32)
export SESSION_SECRET=$(openssl rand -hex 32)
export HIVEMIND_MASTER_API_KEY=$(openssl rand -hex 32)
export HIVEMIND_ADMIN_SECRET=$(openssl rand -hex 32)
export REDIS_PASSWORD=$(openssl rand -hex 32)
export QDRANT_API_KEY=$(openssl rand -hex 32)
export BACKUP_ENCRYPTION_KEY=$(openssl rand -base64 32)

echo "API_MASTER_KEY=$API_MASTER_KEY"
echo "SESSION_SECRET=$SESSION_SECRET"
echo "HIVEMIND_MASTER_API_KEY=$HIVEMIND_MASTER_API_KEY"
echo "HIVEMIND_ADMIN_SECRET=$HIVEMIND_ADMIN_SECRET"
echo "REDIS_PASSWORD=$REDIS_PASSWORD"
echo "QDRANT_API_KEY=$QDRANT_API_KEY"
echo "BACKUP_ENCRYPTION_KEY=$BACKUP_ENCRYPTION_KEY"
```

### 3. Create Environment File

```bash
cp .env.coolify.example .env
```

Edit `.env` and fill in all required values:

```bash
# Required values to set:
# - DOMAIN: Your domain name
# - All *_API_KEY values
# - POSTGRES_PASSWORD
# - REDIS_PASSWORD
# - QDRANT_API_KEY
# - BACKUP_* values
# - GROQ_API_KEY
# - MISTRAL_API_KEY
```

---

## Coolify Configuration

### 1. Create New Resource

1. Log into Coolify dashboard
2. Click **"Create New Resource"**
3. Select **"Docker Compose"**
4. Choose your server

### 2. Configure Git Repository

```
Repository: https://github.com/your-org/hivemind.git
Branch: main
Docker Compose Location: docker-compose.coolify.yml
```

### 3. Environment Variables

In Coolify, add all variables from your `.env` file:

**Critical Variables (Required):**

| Variable | Description |
|----------|-------------|
| `DOMAIN` | Your domain name |
| `API_MASTER_KEY` | Master API key (64 hex chars) |
| `SESSION_SECRET` | Session encryption key |
| `HIVEMIND_MASTER_API_KEY` | HIVE-MIND master key |
| `HIVEMIND_ADMIN_SECRET` | Admin panel secret |
| `POSTGRES_PASSWORD` | Database password |
| `REDIS_PASSWORD` | Redis password |
| `QDRANT_API_KEY` | Qdrant API key |
| `GROQ_API_KEY` | Groq API key |
| `MISTRAL_API_KEY` | Mistral AI key |
| `BACKUP_ENCRYPTION_KEY` | Backup encryption key |
| `BACKUP_S3_*` | S3 backup credentials |

### 4. Build Configuration

Enable **"Build on Server"** and set:

```
Build Args:
  NODE_ENV=production
  VERSION=2.0.0
```

### 5. Health Check

Coolify will automatically detect health checks from the compose file:

```yaml
Health Check URL: http://localhost:3000/health
Interval: 30s
Timeout: 10s
Retries: 3
```

---

## Deployment Steps

### 1. Build PostgreSQL Image with AGE

```bash
# Build custom PostgreSQL image with Apache AGE
docker build -t hivemind/postgres-age:15-alpine \
  -f infra/postgres/Dockerfile.age infra/postgres/

# Push to registry (if using private registry)
docker tag hivemind/postgres-age:15-alpine \
  your-registry.com/hivemind/postgres-age:15-alpine
docker push your-registry.com/hivemind/postgres-age:15-alpine
```

### 2. Deploy via Coolify

1. Click **"Deploy"** in Coolify
2. Wait for build to complete (5-10 minutes)
3. Verify all services are healthy

### 3. Verify Deployment

```bash
# Check service status
docker-compose -f docker-compose.coolify.yml ps

# Check logs
docker-compose -f docker-compose.coolify.yml logs -f app

# Test health endpoint
curl https://your-domain.com/health
```

---

## Post-Deployment

### 1. Database Initialization

```bash
# Run Prisma migrations
docker-compose -f docker-compose.coolify.yml exec app npx prisma migrate deploy

# Verify database connection
docker-compose -f docker-compose.coolify.yml exec app npx prisma db pull
```

### 2. Qdrant Collection Setup

```bash
# Create Qdrant collection
docker-compose -f docker-compose.coolify.yml exec app node scripts/setup-qdrant.js
```

### 3. SSL Certificate

If using Traefik with Coolify, SSL certificates are automatically provisioned via Let's Encrypt.

Verify SSL:
```bash
curl -I https://your-domain.com
# Should show: HTTP/2 200 with valid certificate
```

### 4. Backup Verification

```bash
# Trigger manual backup
docker-compose -f docker-compose.coolify.yml exec backup backup

# Check backup in S3
aws s3 ls s3://your-backup-bucket/ --endpoint-url=https://s3.eu-central-1.amazonaws.com
```

---

## Monitoring

### Health Endpoints

| Endpoint | Purpose |
|----------|---------|
| `GET /health` | Application health |
| `GET /ready` | Readiness probe |
| `GET /metrics` | Prometheus metrics |

### Logs

```bash
# View all logs
docker-compose -f docker-compose.coolify.yml logs -f

# View specific service
docker-compose -f docker-compose.coolify.yml logs -f app

# View with timestamps
docker-compose -f docker-compose.coolify.yml logs -f --timestamps app
```

### Resource Usage

```bash
# Check resource usage
docker stats

# Check disk usage
docker system df
```

---

## Troubleshooting

### Service Won't Start

```bash
# Check for port conflicts
sudo netstat -tlnp | grep 3000
sudo netstat -tlnp | grep 5432
sudo netstat -tlnp | grep 6379

# Check logs for errors
docker-compose -f docker-compose.coolify.yml logs app | tail -100
```

### Database Connection Issues

```bash
# Test database connectivity
docker-compose -f docker-compose.coolify.yml exec app pg_isready -h postgres -U hivemind_user

# Check database logs
docker-compose -f docker-compose.coolify.yml logs postgres
```

### Memory Issues

```bash
# Check memory usage
free -h
docker stats --no-stream

# Adjust memory limits in docker-compose.coolify.yml
# deploy.resources.limits.memory
```

### SSL Certificate Issues

```bash
# Check Traefik logs
docker logs traefik

# Verify DNS
dig your-domain.com

# Check certificate status
curl -v https://your-domain.com 2>&1 | grep -i ssl
```

---

## Security Checklist

- [ ] All passwords are 32+ characters
- [ ] API keys are stored in Coolify secrets
- [ ] Database is not exposed to internet
- [ ] Redis has password authentication
- [ ] Qdrant has API key enabled
- [ ] Backups are encrypted
- [ ] SSL/TLS is enabled
- [ ] Security headers are configured
- [ ] Rate limiting is enabled

---

## EU Sovereign Compliance

### Data Residency

- All data stored in EU regions (eu-central-1, fr-par, etc.)
- Backups encrypted with AES-256
- No data leaves EU jurisdiction

### GDPR Compliance

- Audit logging enabled
- Data retention policies configured
- Right to erasure supported via API
- Data processing agreements with providers

### NIS2 / DORA

- Security monitoring enabled
- Incident response procedures documented
- Regular security updates
- Backup and recovery tested

---

## Support

For issues and questions:

- **Documentation**: https://docs.hivemind.io
- **Issues**: https://github.com/your-org/hivemind/issues
- **Email**: ops@hivemind.io

---

**Version**: 2.0.0  
**Last Updated**: 2026-03-15  
**Compliance**: GDPR, NIS2, DORA

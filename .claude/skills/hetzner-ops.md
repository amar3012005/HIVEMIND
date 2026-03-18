---
name: hetzner-ops
description: Hetzner Cloud infrastructure operations - server health, logs, restarts, scaling, and monitoring
type: reference
---

# Hetzner Operations Skill

## Overview
Manage the HIVEMIND deployment on Hetzner Cloud infrastructure.

## Infrastructure

**Server**: Hetzner Cloud (Falkenstein, DE)
**Domain**: `hivemind.davinciai.eu`
**Port**: `8050` (HTTPS)
**Coolify Project**: `hivemind`
**Application ID**: `s0k0s0k40wo44w4w8gcs8ow0`

## Commands

### `/hetzner status`
Check server and application health.

**Health Endpoints**:
```bash
# API Health
curl https://hivemind.davinciai.eu/health

# Expected: {"ok":true,"service":"hivemind-api"}
```

**Container Status**:
```bash
docker ps --filter "name=s0k0s0k40wo44w4w8gcs8ow0"

# Expected containers:
# - s0k0s0k40wo44w4w8gcs8ow0-230246199607 (HIVEMIND app)
# - hivemind-caddy (SSL termination)
# - postgres-s0k0s0k40wo44w4w8gcs8ow0-... (PostgreSQL)
# - redis-s0k0s0k40wo44w4w8gcs8ow0-... (Redis)
# - qdrant-s0k0s0k40wo44w4w8gcs8ow0-... (Qdrant - local, not Cloud)
```

**Service Checks**:
- [ ] API responding (health endpoint)
- [ ] PostgreSQL running
- [ ] Redis running
- [ ] Caddy SSL valid
- [ ] Embeddings service reachable

### `/hetzner logs`
Stream application logs.

**Commands**:
```bash
# Live tail (last 100 lines, follow)
docker logs s0k0s0k40wo44w4w8gcs8ow0-230246199607 --tail=100 -f

# Search for errors
docker logs s0k0s0k40wo44w4w8gcs8ow0-230246199607 2>&1 | grep -i error

# Search for specific component
docker logs s0k0s0k40wo44w4w8gcs8ow0-230246199607 2>&1 | grep -E "Qdrant|Embedding|MCP"

# Last 5 minutes
docker logs s0k0s0k40wo44w4w8gcs8ow0-230246199607 --since 5m
```

**Log Locations**:
- **Application**: Docker logs
- **Caddy/SSL**: `docker logs hivemind-caddy`
- **PostgreSQL**: `docker logs postgres-s0k0s0k40wo44w4w8gcs8ow0-...`

### `/hetzner restart`
Safe restart procedure.

**Workflow**:
1. Check current health
2. Restart application container
3. Wait for startup (15 seconds)
4. Verify health
5. Check logs for errors

**Command**:
```bash
cd /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0
docker compose restart s0k0s0k40wo44w4w8gcs8ow0-230246199607
sleep 15
curl https://hivemind.davinciai.eu/health
```

**Full Restart** (all services):
```bash
docker compose down
docker compose up -d
```

### `/hetzner scale`
Scale resources.

**Options**:
1. **Vertical**: Upgrade server (more CPU/RAM)
2. **Horizontal**: Add replicas (requires load balancer)

**Current Resources**:
- Check Coolify dashboard for allocation

**Scale Up**:
```bash
# Via Coolify UI
# Resources → hivemind → Upgrade
```

### `/hetzner deploy`
Deploy new code.

**Workflow**:
1. Git push to main branch
2. Coolify auto-deploys
3. Monitor deployment logs
4. Verify health after deploy

**Manual Deploy**:
```bash
cd /opt/HIVEMIND
git pull origin main
cd /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0
docker compose down
docker compose up -d --build
```

### `/hetzner rollback`
Rollback to previous version.

**Workflow**:
1. Identify last known good commit
2. Git checkout
3. Redeploy
4. Verify health

**Command**:
```bash
cd /opt/HIVEMIND
git checkout <last-good-commit>
cd /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0
docker compose down
docker compose up -d --build
```

## Troubleshooting

### Issue: API not responding

**Symptoms**: Health check fails, 502 Bad Gateway

**Diagnosis**:
```bash
# Check container running
docker ps | grep s0k0s0k40wo44w4w8gcs8ow0

# Check logs for errors
docker logs s0k0s0k40wo44w4w8gcs8ow0-230246199607 --tail=50

# Check if port is listening
docker exec s0k0s0k40wo44w4w8gcs8ow0-230246199607 netstat -tlnp | grep 3000
```

**Fix**:
```bash
# Restart container
docker compose restart s0k0s0k40wo44w4w8gcs8ow0-230246199607

# If still failing, check database
docker logs postgres-s0k0s0k40wo44w4w8gcs8ow0-...
```

### Issue: SSL certificate expired

**Symptoms**: Browser shows certificate warning

**Fix**:
```bash
# Check certificate
docker exec hivemind-caddy cat /etc/letsencrypt/live/hivemind.davinciai.eu/cert.pem | openssl x509 -noout -dates

# Renew via Coolify
# Coolify auto-renews via cron

# Manual renewal
docker exec hivemind-caddy certbot renew
docker restart hivemind-caddy
```

### Issue: Database connection failed

**Symptoms**: "Prisma connection error" in logs

**Fix**:
```bash
# Check PostgreSQL running
docker ps | grep postgres

# Check connection string
docker exec s0k0s0k40wo44w4w8gcs8ow0-230246199607 env | grep DATABASE_URL

# Test connection
docker exec postgres-s0k0s0k40wo44w4w8gcs8ow0-... psql -U hivemind_user -d hivemind -c "SELECT 1"

# Restart PostgreSQL
docker compose restart postgres
```

### Issue: Embedding service unreachable

**Symptoms**: "Embedding failed" in logs

**Fix**:
```bash
# Check embeddings container
docker ps | grep embeddings

# Test from HIVEMIND container
docker exec s0k0s0k40wo44w4w8gcs8ow0-230246199607 \
  curl -k https://embeddings-eu-...:4006/embed -d '{"sentences":["test"]}'

# Restart embeddings
docker restart embeddings-eu-f8osow0so0w0c0w8gow8ok8s-...
```

## Key Files

| File | Purpose |
|------|---------|
| `/data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/.env` | Production config |
| `/data/coolify/applications/.../docker-compose.yaml` | Container config |
| `/opt/HIVEMIND/core/src/server.js` | Application entry |
| `/etc/letsencrypt/` | SSL certificates |

## Monitoring Commands

```bash
# CPU/Memory usage
docker stats s0k0s0k40wo44w4w8gcs8ow0-230246199607

# Disk usage
df -h
du -sh /data/coolify/applications/s0k0s0k40wo44w4w8gcs8ow0/*

# Network connections
docker exec s0k0s0k40wo44w4w8gcs8ow0-230246199607 netstat -tlnp

# Process list
docker exec s0k0s0k40wo44w4w8gcs8ow0-230246199607 ps aux
```

## Coolify Management

**URL**: Check your Coolify instance URL

**Common Operations**:
- Restart application: Coolify UI → Applications → hivemind → Restart
- View logs: Coolify UI → Applications → hivemind → Logs
- Environment variables: Coolify UI → Applications → hivemind → Environment
- Deployments: Coolify UI → Applications → hivemind → Deployments

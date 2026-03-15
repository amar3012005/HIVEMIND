# HIVE-MIND Production Deployment Guide
## EU Sovereign Infrastructure - Hetzner/Scaleway/OVHcloud

**Document Version:** 1.0.0  
**Last Updated:** March 9, 2026  
**Target Environment:** Production

---

## Table of Contents

1. [Prerequisites](#1-prerequisites)
2. [Infrastructure Setup](#2-infrastructure-setup)
3. [Docker Compose Deployment](#3-docker-compose-deployment)
4. [Kubernetes Deployment (K3s)](#4-kubernetes-deployment-k3s)
5. [Validation & Testing](#5-validation--testing)
6. [Troubleshooting](#6-troubleshooting)
7. [Post-Deployment](#7-post-deployment)

---

## 1. Prerequisites

### 1.1 Hardware Requirements

| Component | Minimum | Production | Provider |
|-----------|---------|------------|----------|
| Compute | 4 vCPU, 8GB RAM | 8 vCPU, 32GB RAM | Hetzner AX52 |
| Storage | 200GB NVMe | 1TB NVMe | LUKS2 encrypted |
| Network | 1 Gbps | 10 Gbps | Private network |

### 1.2 Software Requirements

```bash
# Required on host
- Docker 24.0+
- Docker Compose 2.20+
- Kubernetes (K3s) 1.28+ (optional)
- OpenSSL 3.0+
- cryptsetup 2.6+ (for LUKS2)
- AWS CLI v2 (for S3 backups)
```

### 1.3 Environment Variables

Create `.env.production` file:

```bash
# Domain Configuration
DOMAIN_NAME=hivemind.io
ACME_EMAIL=ops@hivemind.io

# Cloudflare DNS (for Let's Encrypt)
CLOUDFLARE_DNS_API_TOKEN=your_cloudflare_token

# Traefik Dashboard
TRAEFIK_DASHBOARD_CREDENTIALS=admin:$(openssl passwd -apr1 changeme)

# Database
POSTGRES_PASSWORD=<generate-secure-password>
POSTGRES_USER=hivemind
POSTGRES_DB=hivemind

# Redis
REDIS_PASSWORD=<generate-secure-password>

# Qdrant
QDRANT_API_KEY=<generate-secure-key>

# ZITADEL (Identity Provider)
ZITADEL_ISSUER_URL=https://auth.hivemind.io
ZITADEL_CLIENT_ID=<your-client-id>
ZITADEL_CLIENT_SECRET=<your-client-secret>

# HSM Key (OVHcloud)
HSM_MASTER_KEY=<hsm-key-reference>

# Grafana
GRAFANA_ADMIN_USER=admin
GRAFANA_ADMIN_PASSWORD=<generate-secure-password>

# Backup (Scaleway S3)
SCW_ACCESS_KEY=<scaleway-access-key>
SCW_SECRET_KEY=<scaleway-secret-key>
BACKUP_BUCKET=hivemind-backups
BACKUP_ENCRYPTION_KEY=<generate-256-bit-key>

# Sentry (Optional)
SENTRY_DSN=https://<key>@sentry.io/<project>
```

### 1.4 Generate Secure Passwords

```bash
# Generate secure passwords
openssl rand -base64 32  # For POSTGRES_PASSWORD
openssl rand -base64 32  # For REDIS_PASSWORD
openssl rand -base64 32  # For QDRANT_API_KEY
openssl rand -hex 32     # For BACKUP_ENCRYPTION_KEY

# Generate Traefik dashboard credentials
htpasswd -nb admin <password> | sed -e s/\\$/\\$\\$/g
```

---

## 2. Infrastructure Setup

### 2.1 Server Provisioning (Hetzner)

```bash
# SSH into server
ssh root@<server-ip>

# Update system
apt update && apt upgrade -y

# Install Docker
curl -fsSL https://get.docker.com | sh
systemctl enable docker
systemctl start docker

# Install Docker Compose
apt install docker-compose-plugin -y

# Install required tools
apt install -y openssl cryptsetup awscli jq

# Create directories
mkdir -p /mnt/encrypted/{postgres,redis,qdrant,prometheus,grafana,backups,traefik-acme}
mkdir -p /var/log/{traefik,hivemind}
mkdir -p /etc/hivemind
```

### 2.2 LUKS2 Volume Encryption

```bash
# Copy encryption script
scp infra/luks2/setup-encryption.sh root@<server-ip>:/usr/local/bin/

# Create device mapping file
cat > /etc/hivemind/volume-devices.conf << EOF
postgres:/dev/sdb1
redis:/dev/sdc1
qdrant:/dev/sdd1
prometheus:/dev/sde1
grafana:/dev/sdf1
backups:/dev/sdg1
EOF

# Initialize encryption
export MASTER_KEY_FILE=/etc/hivemind/luks-master.key
/usr/local/bin/setup-encryption.sh init

# Verify encryption
/usr/local/bin/setup-encryption.sh verify

# Open all volumes
for vol in postgres redis qdrant prometheus grafana backups; do
    /usr/local/bin/setup-encryption.sh open --volume $vol
done
```

### 2.3 Configure crypttab for Boot

```bash
# Add to /etc/crypttab
cat >> /etc/crypttab << EOF
# HIVE-MIND encrypted volumes
hivemind-postgres /dev/sdb1 /etc/hivemind/luks-master.key luks,discard
hivemind-redis /dev/sdc1 /etc/hivemind/luks-master.key luks,discard
hivemind-qdrant /dev/sdd1 /etc/hivemind/luks-master.key luks,discard
hivemind-prometheus /dev/sde1 /etc/hivemind/luks-master.key luks,discard
hivemind-grafana /dev/sdf1 /etc/hivemind/luks-master.key luks,discard
hivemind-backups /dev/sdg1 /etc/hivemind/luks-master.key luks,discard
EOF

# Add to /etc/fstab
cat >> /etc/fstab << EOF
# HIVE-MIND encrypted volumes
/dev/mapper/hivemind-postgres /mnt/encrypted/postgres ext4 defaults,noatime 0 2
/dev/mapper/hivemind-redis /mnt/encrypted/redis ext4 defaults,noatime 0 2
/dev/mapper/hivemind-qdrant /mnt/encrypted/qdrant ext4 defaults,noatime 0 2
/dev/mapper/hivemind-prometheus /mnt/encrypted/prometheus ext4 defaults,noatime 0 2
/dev/mapper/hivemind-grafana /mnt/encrypted/grafana ext4 defaults,noatime 0 2
/dev/mapper/hivemind-backups /mnt/encrypted/backups ext4 defaults,noatime 0 2
EOF
```

---

## 3. Docker Compose Deployment

### 3.1 Clone Repository

```bash
# Clone HIVE-MIND repository
git clone https://github.com/hivemind/hivemind.git
cd hivemind

# Copy environment file
cp infra/.env.example .env.production
# Edit .env.production with your values
```

### 3.2 Deploy Stack

```bash
# Validate configuration
docker-compose -f infra/docker-compose.production.yml config

# Pull images
docker-compose -f infra/docker-compose.production.yml pull

# Start services
docker-compose -f infra/docker-compose.production.yml up -d

# Check status
docker-compose -f infra/docker-compose.production.yml ps
```

### 3.3 Initialize Database

```bash
# Wait for PostgreSQL to be ready
sleep 30

# Run migrations
docker exec hivemind-api npx prisma migrate deploy

# Seed initial data (optional)
docker exec hivemind-api npm run db:seed
```

### 3.4 Deploy Monitoring Stack

```bash
# Start monitoring
docker-compose -f infra/monitoring/docker-compose.monitoring.yml up -d

# Check monitoring status
docker-compose -f infra/monitoring/docker-compose.monitoring.yml ps
```

### 3.5 Configure Backups

```bash
# Test backup
docker exec hivemind-backup /backup.sh

# Verify backup
ls -la /mnt/encrypted/backups/daily/
```

---

## 4. Kubernetes Deployment (K3s)

### 4.1 Install K3s

```bash
# Install K3s
curl -sfL https://get.k3s.io | sh -

# Get kubeconfig
mkdir -p ~/.kube
cp /etc/rancher/k3s/k3s.yaml ~/.kube/config
chmod 600 ~/.kube/config

# Verify cluster
kubectl cluster-info
kubectl get nodes
```

### 4.2 Deploy Namespace and RBAC

```bash
# Apply namespace
kubectl apply -f infra/k8s/namespace.yaml

# Verify
kubectl get namespace hivemind
kubectl get resourcequota -n hivemind
kubectl get limitrange -n hivemind
```

### 4.3 Deploy Database

```bash
# Apply PostgreSQL StatefulSet
kubectl apply -f infra/k8s/postgres-statefulset.yaml

# Wait for PostgreSQL
kubectl wait --for=condition=ready pod -l app=postgres -n hivemind --timeout=300s

# Verify
kubectl get statefulset -n hivemind
kubectl get pvc -n hivemind
```

### 4.4 Deploy API

```bash
# Apply API deployment
kubectl apply -f infra/k8s/api-deployment.yaml

# Wait for API
kubectl wait --for=condition=ready pod -l app=hivemind-api -n hivemind --timeout=300s

# Verify
kubectl get deployment -n hivemind
kubectl get hpa -n hivemind
```

### 4.5 Deploy Ingress

```bash
# Apply ingress
kubectl apply -f infra/k8s/ingress.yaml

# Verify
kubectl get ingress -n hivemind
kubectl get svc -n hivemind
```

### 4.6 Run Database Migrations

```bash
# Run migrations in Kubernetes
kubectl run db-migration --rm -it \
    --image=hivemind/core:latest \
    --namespace=hivemind \
    --env="DATABASE_URL=postgresql://hivemind:<password>@postgres:5432/hivemind" \
    --command -- npx prisma migrate deploy
```

---

## 5. Validation & Testing

### 5.1 Health Checks

```bash
# API health
curl -f https://api.hivemind.io/health

# API ready
curl -f https://api.hivemind.io/ready

# PostgreSQL
docker exec hivemind-postgres pg_isready -U hivemind

# Redis
docker exec hivemind-redis redis-cli -a <password> ping

# Qdrant
curl -f http://localhost:6333/healthz

# Traefik
curl -f http://localhost:8080/ping
```

### 5.2 Security Validation

```bash
# Verify non-root containers
for container in $(docker ps -q); do
    echo "Container: $(docker inspect --format '{{.Name}}' $container)"
    docker exec $container whoami || echo "  Cannot exec (may be distroless)"
done

# Verify TLS configuration
nmap --script ssl-enum-ciphers -p 443 api.hivemind.io

# Verify security headers
curl -I https://api.hivemind.io | grep -E "Strict-Transport-Security|X-Frame-Options|X-Content-Type-Options"

# Verify LUKS2 encryption
cryptsetup luksDump /dev/sdb1 | head -20
```

### 5.3 Performance Testing

```bash
# Load test with hey
hey -z 5m -c 10 https://api.hivemind.io/health

# Check response times
curl -w "@curl-format.txt" -o /dev/null -s https://api.hivemind.io/health

# curl-format.txt content:
# time_namelookup:  %{time_namelookup}\n
# time_connect:     %{time_connect}\n
# time_appconnect:  %{time_appconnect}\n
# time_pretransfer: %{time_pretransfer}\n
# time_starttransfer: %{time_starttransfer}\n
# ----------\n
# time_total:       %{time_total}\n
```

### 5.4 Backup Verification

```bash
# Test restore to temporary database
export POSTGRES_HOST=localhost
export POSTGRES_PORT=5433
export RESTORE_FROM=latest
./scripts/restore-postgres.sh --dry-run

# Verify backup integrity
sha256sum -c /backups/daily/*.sha256
```

---

## 6. Troubleshooting

### 6.1 Common Issues

#### API Won't Start

```bash
# Check logs
docker logs hivemind-api --tail 100

# Check dependencies
docker-compose -f infra/docker-compose.production.yml ps postgres redis qdrant

# Verify database connection
docker exec hivemind-api env | grep DATABASE_URL
```

#### PostgreSQL Connection Issues

```bash
# Check PostgreSQL status
docker exec hivemind-postgres pg_isready -U hivemind

# Check connections
docker exec hivemind-postgres psql -U hivemind -c "SELECT count(*) FROM pg_stat_activity;"

# Restart PostgreSQL
docker-compose -f infra/docker-compose.production.yml restart postgres
```

#### TLS Certificate Issues

```bash
# Check Traefik logs
docker logs hivemind-traefik --tail 100

# Check ACME challenges
docker exec hivemind-traefik cat /acme/acme.json | jq

# Force certificate renewal
docker-compose -f infra/docker-compose.production.yml restart traefik
```

#### Backup Failures

```bash
# Check backup logs
docker logs hivemind-backup --tail 100

# Verify S3 credentials
aws s3 ls s3://hivemind-backups --endpoint-url https://s3.fr-par.scw.cloud

# Test backup manually
docker exec hivemind-backup /backup.sh
```

### 6.2 Emergency Procedures

#### Force Database Reset

```bash
# WARNING: This will delete all data!
docker exec hivemind-postgres psql -U hivemind -c "DROP DATABASE hivemind;"
docker exec hivemind-postgres psql -U hivemind -c "CREATE DATABASE hivemind;"
docker exec hivemind-api npx prisma migrate deploy
```

#### Emergency Access

```bash
# Bypass Traefik for direct API access
docker exec hivemind-api curl http://localhost:3000/health

# Direct database access
docker exec -it hivemind-postgres psql -U hivemind
```

---

## 7. Post-Deployment

### 7.1 Configure DNS

```bash
# Add DNS records via Cloudflare API
curl -X POST "https://api.cloudflare.com/client/v4/zones/<zone-id>/dns_records" \
    -H "Authorization: Bearer <token>" \
    -H "Content-Type: application/json" \
    --data '{
        "type": "A",
        "name": "api.hivemind.io",
        "content": "<server-ip>",
        "proxied": true
    }'
```

### 7.2 Configure Monitoring Alerts

1. Access Grafana: https://grafana.hivemind.io
2. Login with admin credentials
3. Navigate to Alerting > Contact points
4. Add Slack/Email notification channel
5. Configure alert rules

### 7.3 Setup CI/CD

1. Configure GitHub repository secrets
2. Enable GitHub Actions
3. Deploy staging environment
4. Test production deployment

### 7.4 Documentation

- [ ] Update runbooks with actual IPs and endpoints
- [ ] Document team escalation procedures
- [ ] Schedule DR testing
- [ ] Configure on-call rotation

---

## Appendix A: Quick Reference Commands

```bash
# Start all services
docker-compose -f infra/docker-compose.production.yml up -d

# Stop all services
docker-compose -f infra/docker-compose.production.yml down

# View logs
docker-compose -f infra/docker-compose.production.yml logs -f api

# Restart service
docker-compose -f infra/docker-compose.production.yml restart api

# Scale API
docker-compose -f infra/docker-compose.production.yml up -d --scale api=3

# Database backup
./scripts/backup-postgres.sh

# Database restore
./scripts/restore-postgres.sh --latest

# Check encryption
cryptsetup status /dev/mapper/hivemind-postgres
```

---

## Appendix B: File Locations

| File | Path |
|------|------|
| Docker Compose | `infra/docker-compose.production.yml` |
| Traefik Config | `infra/traefik/traefik.yml` |
| K8s Manifests | `infra/k8s/` |
| Backup Scripts | `scripts/backup-postgres.sh` |
| Restore Scripts | `scripts/restore-postgres.sh` |
| DR Plan | `scripts/disaster-recovery.md` |
| LUKS2 Setup | `infra/luks2/setup-encryption.sh` |

---

**END OF DEPLOYMENT GUIDE**

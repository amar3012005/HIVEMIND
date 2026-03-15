# HIVE-MIND Coolify Quickstart Guide

Deploy HIVE-MIND to Coolify in under 10 minutes on EU sovereign cloud infrastructure.

## Prerequisites

- [Coolify](https://coolify.io/) instance running (self-hosted or managed)
- EU cloud provider account (Hetzner, Scaleway, or OVHcloud)
- API keys for Groq and Mistral AI

## Step 1: Prepare Your Environment (2 minutes)

```bash
# Clone the repository
git clone https://github.com/your-org/hivemind.git
cd hivemind

# Copy environment template
cp .env.coolify .env.coolify.local

# Edit with your favorite editor
nano .env.coolify.local
```

### Required Variables

```bash
# Database (use managed PostgreSQL if available)
DATABASE_URL=postgresql://user:pass@host:5432/hivemind?schema=public

# Vector Store (Qdrant Cloud EU region recommended)
QDRANT_URL=https://your-cluster.qdrant.io:6333
QDRANT_API_KEY=your-qdrant-api-key

# LLM APIs
GROQ_API_KEY=your-groq-api-key
MISTRAL_API_KEY=your-mistral-api-key

# Security (generate with: openssl rand -hex 32)
API_MASTER_KEY=$(openssl rand -hex 32)
SESSION_SECRET=$(openssl rand -hex 32)
HIVEMIND_MASTER_API_KEY=hmk_live_$(openssl rand -hex 16)
HIVEMIND_ADMIN_SECRET=$(openssl rand -hex 32)
```

## Step 2: Deploy to Coolify (3 minutes)

### Option A: Automated Script

```bash
chmod +x scripts/deploy-coolify.sh
./scripts/deploy-coolify.sh production
```

### Option B: Manual Coolify Setup

1. **Log in to Coolify Dashboard**
   ```
   https://your-coolify-instance.coolify.io
   ```

2. **Create New Application**
   - Click "+ New Application"
   - Select "Private Repository"
   - Enter your GitHub/GitLab URL

3. **Configure Build**
   ```
   Build Command: docker build -f Dockerfile.production -t hivemind .
   Port: 3000
   ```

4. **Add Environment Variables**
   - Go to "Environment Variables"
   - Copy contents from `.env.coolify.local`
   - Paste into Coolify

5. **Set Health Check**
   ```
   Path: /health
   Interval: 30s
   Timeout: 10s
   ```

6. **Deploy**
   - Click "Deploy"
   - Wait for build to complete

## Step 3: Verify Deployment (2 minutes)

```bash
# Check health endpoint
curl https://your-domain.com/health

# Expected response:
# {"ok":true,"service":"hivemind-api","port":3000}

# Test API
curl -X POST https://your-domain.com/api/generate \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer ${HIVEMIND_MASTER_API_KEY}" \
  -d '{"prompt":"Hello, HIVE-MIND!"}'
```

## Step 4: Database Setup (3 minutes)

If using managed PostgreSQL:

```bash
# Run migrations
cd core
npm install
export DATABASE_URL="your-production-database-url"
npm run db:migrate
```

If using Coolify's PostgreSQL service:

1. Add PostgreSQL service in Coolify
2. Link to your application
3. Run migrations via Coolify's console

## Configuration Options

### Minimal Setup (Single Container)

Use only the `app` service with external managed databases:

```yaml
# coolify.yaml (simplified)
version: '3.8'
services:
  app:
    build:
      dockerfile: Dockerfile.production
    environment:
      - DATABASE_URL=${DATABASE_URL}  # Managed PostgreSQL
      - QDRANT_URL=${QDRANT_URL}      # Qdrant Cloud
      - REDIS_URL=${REDIS_URL}        # Redis Cloud
    ports:
      - "3000:3000"
    healthcheck:
      test: ["CMD", "curl", "-f", "http://localhost:3000/health"]
```

### Full Stack Setup

Include all services (PostgreSQL, Qdrant, Redis):

```bash
# Use docker-compose.coolify.yml
docker-compose -f docker-compose.coolify.yml up -d
```

## EU Sovereign Cloud Providers

### Hetzner (Germany)

```bash
# Create server
# Location: Falkenstein (fsn1) or Helsinki (hel1)
# Type: CPX31 (4 vCPUs, 8 GB RAM, €12.40/month)

# Install Coolify
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

### Scaleway (France)

```bash
# Create instance
# Location: Paris (fr-par)
# Type: DEV1-L (4 vCPUs, 8 GB RAM, €15.99/month)

# Install Coolify
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

### OVHcloud (France)

```bash
# Create instance
# Location: Gravelines (GRA)
# Type: Advance-1 (4 vCPUs, 8 GB RAM, €14.99/month)

# Install Coolify
curl -fsSL https://cdn.coollabs.io/coolify/install.sh | bash
```

## Troubleshooting

### Container Won't Start

```bash
# Check logs in Coolify dashboard
# Or via SSH:
docker logs hivemind-api

# Verify environment variables
docker exec hivemind-api env | grep -E "(DATABASE|QDRANT|GROQ)"
```

### Health Check Failing

```bash
# Test locally
curl http://localhost:3000/health

# Check if port is listening
netstat -tlnp | grep 3000
```

### Database Connection Issues

```bash
# Test connection
docker exec -it hivemind-api psql "${DATABASE_URL}" -c "SELECT 1;"

# Verify DATABASE_URL format
# Should be: postgresql://user:pass@host:5432/db?schema=public
```

## Next Steps

- [Complete Deployment Guide](./coolify-deployment.md)
- [API Reference](./API_REFERENCE.md)
- [GDPR Compliance](../compliance/GDPR.md)

## Support

- **Issues**: https://github.com/hivemind/issues
- **Documentation**: https://docs.hivemind.io
- **Email**: ops@hivemind.io

---

**Deploy Time**: ~10 minutes  
**EU Compliant**: ✅ GDPR, NIS2, DORA  
**Data Residency**: EU-only

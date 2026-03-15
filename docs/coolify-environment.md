# HIVE-MIND Coolify Environment Variables

Complete reference for all environment variables used in Coolify deployment.

## Core Application

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NODE_ENV` | ✅ | `production` | Node.js environment mode |
| `PORT` | ✅ | `3000` | Application port |
| `VERSION` | ❌ | `1.0.0` | Application version |
| `HOST` | ❌ | `0.0.0.0` | Bind host address |

## Database (PostgreSQL + Apache AGE)

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `DATABASE_URL` | ✅ | `postgresql://user:pass@host:5432/hivemind?schema=public` | Full PostgreSQL connection string |
| `POSTGRES_USER` | ⚠️ | `hivemind` | PostgreSQL username (for self-hosted) |
| `POSTGRES_PASSWORD` | ⚠️ | - | PostgreSQL password (for self-hosted) |
| `POSTGRES_DB` | ⚠️ | `hivemind` | PostgreSQL database name (for self-hosted) |

⚠️ Required if using self-hosted PostgreSQL via docker-compose

### Managed PostgreSQL Providers (EU)

**Scaleway (France)**
```bash
DATABASE_URL=postgresql://user:password@your-db.pg.fr-par.scw.cloud:5432/hivemind?schema=public
```

**Hetzner (Germany)**
```bash
DATABASE_URL=postgresql://user:password@your-db.db.hetzner.com:5432/hivemind?schema=public
```

**OVHcloud (France)**
```bash
DATABASE_URL=postgresql://user:password@your-db.database.cloud.ovh.net:5432/hivemind?schema=public
```

## Vector Store (Qdrant)

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `QDRANT_URL` | ✅ | `http://qdrant:6333` | Qdrant HTTP endpoint |
| `QDRANT_API_KEY` | ✅ | `your-api-key` | Qdrant API key for authentication |

### Qdrant Cloud (EU Region)

```bash
QDRANT_URL=https://your-cluster.qdrant.io:6333
QDRANT_API_KEY=your-qdrant-cloud-api-key
```

## Redis (Sessions & Pub/Sub)

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `REDIS_URL` | ⚠️ | `redis://:pass@redis:6379` | Redis connection string |
| `REDIS_PASSWORD` | ⚠️ | `your-password` | Redis password (for self-hosted) |

⚠️ Required if using Redis features

### Redis Cloud (EU)

```bash
REDIS_URL=redis://default:password@your-db.redis-cloud.com:6379
```

## LLM APIs

### Groq (Inference)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `GROQ_API_KEY` | ✅ | - | Groq API key from console.groq.com |
| `GROQ_INFERENCE_MODEL` | ❌ | `llama-3.3-70b-versatile` | Default inference model |

Get your API key: https://console.groq.com/

### Mistral AI (Embeddings)

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `MISTRAL_API_KEY` | ✅ | - | Mistral API key from console.mistral.ai |
| `MISTRAL_EMBEDDING_MODEL` | ❌ | `mistral-embed` | Embedding model name |

Get your API key: https://console.mistral.ai/

## Security

| Variable | Required | Generation | Description |
|----------|----------|------------|-------------|
| `API_MASTER_KEY` | ✅ | `openssl rand -hex 32` | Master API key for authentication |
| `SESSION_SECRET` | ✅ | `openssl rand -hex 32` | Session encryption secret |
| `HIVEMIND_MASTER_API_KEY` | ✅ | `hmk_live_$(openssl rand -hex 16)` | HIVE-MIND master API key |
| `HIVEMIND_ADMIN_SECRET` | ✅ | `openssl rand -hex 32` | Admin panel secret |

### Generating Secure Keys

```bash
# Generate API master key
export API_MASTER_KEY=$(openssl rand -hex 32)

# Generate session secret
export SESSION_SECRET=$(openssl rand -hex 32)

# Generate HIVE-MIND master key
export HIVEMIND_MASTER_API_KEY="hmk_live_$(openssl rand -hex 16)"

# Generate admin secret
export HIVEMIND_ADMIN_SECRET=$(openssl rand -hex 32)
```

## Feature Flags

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `USE_SITUATIONALIZER` | ❌ | `true` | Enable situational context awareness |
| `USE_CONTEXTUAL_EMBEDDING` | ❌ | `true` | Enable contextual embeddings |
| `USE_AST_CHUNKING` | ❌ | `true` | Enable AST-based code chunking |
| `USE_STATEFUL_MANAGER` | ❌ | `true` | Enable stateful memory management |
| `USE_QDRANT_STORAGE` | ❌ | `true` | Enable Qdrant vector storage |

## Audit & Compliance

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `AUDIT_LOG_PATH` | ❌ | `/app/logs/audit.log` | Path to audit log file |
| `AUDIT_RETENTION_DAYS` | ❌ | `2555` | Audit log retention (7 years) |

## Rate Limiting

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `RATE_LIMIT_WINDOW_MS` | ❌ | `60000` | Rate limit window in milliseconds |
| `RATE_LIMIT_MAX_REQUESTS` | ❌ | `100` | Max requests per window |

## EU Sovereign Settings

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `EU_REGION` | ❌ | `eu-central-1` | EU region identifier |
| `DATA_RESIDENCY` | ❌ | `EU` | Data residency requirement |
| `GDPR_MODE` | ❌ | `true` | Enable GDPR compliance mode |
| `CLOUD_PROVIDER` | ❌ | `hetzner` | Cloud provider (hetzner, scaleway, ovhcloud) |

## Logging

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `LOG_LEVEL` | ❌ | `info` | Log level (debug, info, warn, error) |
| `LOG_FORMAT` | ❌ | `json` | Log format (json, text) |

## Backup Configuration

| Variable | Required | Description |
|----------|----------|-------------|
| `SCW_ACCESS_KEY` | ⚠️ | Scaleway access key for backups |
| `SCW_SECRET_KEY` | ⚠️ | Scaleway secret key for backups |
| `BACKUP_BUCKET` | ⚠️ | S3 bucket name for backups |
| `BACKUP_ENCRYPTION_KEY` | ⚠️ | Encryption key for backups |

⚠️ Required if using automated backups

## Monitoring (Optional)

| Variable | Required | Description |
|----------|----------|-------------|
| `SENTRY_DSN` | ❌ | Sentry DSN for error tracking |
| `ENABLE_METRICS` | ❌ | Enable Prometheus metrics |
| `METRICS_PORT` | ❌ | Port for metrics endpoint |

## Coolify-Specific

| Variable | Required | Description |
|----------|----------|-------------|
| `COOLIFY_DOMAIN` | ❌ | Domain assigned by Coolify |
| `COOLIFY_SSL_ENABLED` | ❌ | Enable SSL/TLS |
| `COOLIFY_AUTO_DEPLOY` | ❌ | Enable auto-deployment |

## Complete Example

```bash
# =============================================================================
# HIVE-MIND Production Environment
# =============================================================================

# Core
NODE_ENV=production
PORT=3000

# Database (Scaleway Managed PostgreSQL)
DATABASE_URL=postgresql://hivemind:secure-password@hivemind-db.pg.fr-par.scw.cloud:5432/hivemind?schema=public

# Vector Store (Qdrant Cloud EU)
QDRANT_URL=https://hivemind-cluster.qdrant.io:6333
QDRANT_API_KEY=your-qdrant-api-key

# Redis (Redis Cloud EU)
REDIS_URL=redis://default:password@hivemind-redis.redis-cloud.com:6379

# LLM APIs
GROQ_API_KEY=gsk_your_groq_api_key
GROQ_INFERENCE_MODEL=llama-3.3-70b-versatile
MISTRAL_API_KEY=your_mistral_api_key
MISTRAL_EMBEDDING_MODEL=mistral-embed

# Security (generate with openssl rand -hex 32)
API_MASTER_KEY=a1b2c3d4e5f6...
SESSION_SECRET=f6e5d4c3b2a1...
HIVEMIND_MASTER_API_KEY=hmk_live_a1b2c3d4...
HIVEMIND_ADMIN_SECRET=1a2b3c4d5e6f...

# Features
USE_SITUATIONALIZER=true
USE_CONTEXTUAL_EMBEDDING=true
USE_QDRANT_STORAGE=true

# Compliance
EU_REGION=eu-central-1
DATA_RESIDENCY=EU
GDPR_MODE=true

# Logging
LOG_LEVEL=info
LOG_FORMAT=json
AUDIT_LOG_PATH=/app/logs/audit.log
AUDIT_RETENTION_DAYS=2555

# Rate Limiting
RATE_LIMIT_WINDOW_MS=60000
RATE_LIMIT_MAX_REQUESTS=100

# Backups (Scaleway Object Storage)
SCW_ACCESS_KEY=SCWXXXXXXXXXXXXXXXXX
SCW_SECRET_KEY=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
BACKUP_BUCKET=hivemind-backups-eu
BACKUP_ENCRYPTION_KEY=your-backup-encryption-key
```

## Validation

Run the validation script to check your environment:

```bash
./scripts/validate-coolify.sh
```

## Security Notes

1. **Never commit `.env.coolify` to git**
2. **Rotate keys regularly** (every 90 days recommended)
3. **Use managed databases** when possible
4. **Enable audit logging** for compliance
5. **Verify EU data residency** with your providers

## Support

- **Documentation**: https://docs.hivemind.io
- **Issues**: https://github.com/hivemind/issues
- **Email**: ops@hivemind.io

# HIVE-MIND Coolify Deployment

Production-ready deployment configuration for [Coolify](https://coolify.io/) on EU sovereign cloud infrastructure.

## 🚀 Quick Start

```bash
# 1. Clone and configure
git clone https://github.com/your-org/hivemind.git
cd hivemind
cp .env.coolify .env.coolify.local
# Edit .env.coolify.local with your values

# 2. Validate configuration
./scripts/validate-coolify.sh

# 3. Deploy
./scripts/deploy-coolify.sh production
```

## 📁 Files Created

| File | Purpose |
|------|---------|
| `coolify.yaml` | Main Coolify deployment configuration |
| `.env.coolify` | Environment variables template |
| `docker-compose.coolify.yml` | Docker Compose for Coolify |
| `scripts/deploy-coolify.sh` | Automated deployment script |
| `scripts/validate-coolify.sh` | Configuration validator |
| `.github/workflows/coolify-deploy.yml` | GitHub Actions CI/CD |
| `docs/coolify-deployment.md` | Complete deployment guide |
| `docs/coolify-quickstart.md` | 10-minute quickstart |
| `docs/coolify-environment.md` | Environment variables reference |

## 🏗️ Architecture

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

## ✅ EU Sovereign Compliance

- **GDPR**: Full compliance with data protection regulations
- **NIS2**: Network and information security directive
- **DORA**: Digital operational resilience act
- **Data Residency**: EU-only data storage
- **LUKS2 Encryption**: At-rest encryption
- **TLS 1.3**: In-transit encryption

## 🌍 Supported Cloud Providers

| Provider | Location | Instance Type | Price/Month |
|----------|----------|---------------|-------------|
| **Hetzner** | Falkenstein (DE) | CPX31 (4 vCPU, 8GB) | €12.40 |
| **Scaleway** | Paris (FR) | DEV1-L (4 vCPU, 8GB) | €15.99 |
| **OVHcloud** | Gravelines (FR) | Advance-1 (4 vCPU, 8GB) | €14.99 |

## 🔧 Configuration

### Minimal Setup (External Services)

Use managed databases to minimize infrastructure:

```yaml
# coolify.yaml
services:
  app:
    build:
      dockerfile: Dockerfile.production
    environment:
      - DATABASE_URL=${DATABASE_URL}      # Scaleway PostgreSQL
      - QDRANT_URL=${QDRANT_URL}          # Qdrant Cloud
      - REDIS_URL=${REDIS_URL}            # Redis Cloud
    ports:
      - "3000:3000"
```

### Full Stack Setup (Self-Hosted)

Include all services in Coolify:

```bash
docker-compose -f docker-compose.coolify.yml up -d
```

## 🔐 Security Features

- **Non-root containers**: All services run as non-root
- **No new privileges**: `security_opt: no-new-privileges:true`
- **Capability dropping**: Minimal container capabilities
- **Health checks**: All services have health checks
- **Resource limits**: CPU and memory constraints
- **Network isolation**: Private bridge network

## 📊 Health Checks

| Service | Endpoint | Interval |
|---------|----------|----------|
| API | `/health` | 30s |
| PostgreSQL | `pg_isready` | 10s |
| Qdrant | `/healthz` | 10s |
| Redis | `redis-cli ping` | 10s |

## 🔄 CI/CD Pipeline

GitHub Actions workflow includes:

1. **Lint & Test**: ESLint, type checking, unit tests
2. **Security Scan**: Trivy vulnerability scanning
3. **Build & Push**: Multi-platform Docker builds
4. **Deploy Staging**: Auto-deploy on `develop` branch
5. **Deploy Production**: Tag-based deployment
6. **Database Migrations**: Automated Prisma migrations

## 📚 Documentation

- [Complete Deployment Guide](./docs/coolify-deployment.md)
- [Quickstart Guide](./docs/coolify-quickstart.md)
- [Environment Variables](./docs/coolify-environment.md)
- [API Reference](./docs/API_REFERENCE.md)

## 🛠️ Troubleshooting

### Validation

```bash
./scripts/validate-coolify.sh
```

### Common Issues

**Container won't start:**
```bash
docker logs hivemind-api
```

**Health check failing:**
```bash
curl http://localhost:3000/health
```

**Database connection:**
```bash
docker exec -it hivemind-api psql "${DATABASE_URL}" -c "SELECT 1;"
```

## 📞 Support

- **Issues**: https://github.com/hivemind/issues
- **Documentation**: https://docs.hivemind.io
- **Email**: ops@hivemind.io
- **Status**: https://status.hivemind.io

## 📝 License

Proprietary - See LICENSE file for details.

---

**Version**: 1.0.0  
**Last Updated**: 2026-03-15  
**Compliance**: GDPR, NIS2, DORA

# HIVE-MIND - Local Development Runbook

**Last Updated:** 2026-03-12  
**Version:** 1.0.0

---

## 🚀 Quick Start (One Command)

```bash
# Start the entire stack with one command
cd /Users/amar/HIVE-MIND
./scripts/start-local.sh
```

This single command will:
1. Start PostgreSQL + Apache AGE
2. Start Qdrant vector database
3. Start the HIVE-MIND API server
4. Open the UI in your browser

---

## 📋 Prerequisites

### Required Software
- **Docker Desktop** (Mac/Windows) or **Docker Engine** (Linux)
- **Node.js** v20+ 
- **Git**

### Check Prerequisites
```bash
# Verify Docker
docker --version  # Should be 20.x+

# Verify Node.js
node --version    # Should be v20.x+

# Verify npm
npm --version     # Should be 9.x+
```

---

## 🔧 Setup Steps

### Step 1: Clone Repository
```bash
git clone https://github.com/your-org/hivemind.git
cd hivemind
```

### Step 2: Create Environment File
```bash
cp .env.example .env
```

Edit `.env` and add your API keys:
```bash
# 🔴 SECURITY NOTICE: Generate new key at https://console.groq.com/
# Previous key was compromised - see project_status/KEY_ROTATION_RECORD.md
# Get from https://console.groq.com/
GROQ_API_KEY=gsk_your-new-key-here

# Get from https://console.mistral.ai/
MISTRAL_API_KEY=your-key-here
```

### Step 3: Install Dependencies
```bash
cd core
npm install
```

### Step 4: Start Docker Stack
```bash
# From project root
docker compose -f docker-compose.local-stack.yml up -d
```

### Step 5: Verify Services
```bash
# Check all containers are running
docker compose ps

# Expected output:
# NAME                  STATUS              PORTS
# hivemind-postgres     Up (healthy)        5432/tcp
# hivemind-qdrant       Up (healthy)        9200:6333/tcp
```

### Step 6: Start API Server
```bash
cd core
npm run server
```

### Step 7: Open UI
```
http://localhost:3000
```

---

## 🧪 Run Tests

### All Tests
```bash
./scripts/run-tests.sh
```

### Individual Test Suites
```bash
# API endpoint tests
npm run test:api

# Unit tests
npm run test:unit

# Integration tests
npm run test:integration

# With coverage
npm run test:coverage
```

### Validate Docker Stack
```bash
./scripts/validate-docker.sh
```

### Security Scan
```bash
./scripts/scan-secrets.sh
```

---

## 🛠️ Common Tasks

### View Logs
```bash
# All services
docker compose logs -f

# Specific service
docker compose logs -f hivemind-qdrant
docker compose logs -f hivemind-postgres

# API server (in terminal where it's running)
# Just scroll up in the terminal
```

### Restart Services
```bash
# Restart everything
docker compose restart

# Restart specific service
docker compose restart hivemind-qdrant

# Restart API server
# Press Ctrl+C in the server terminal, then:
npm run server
```

### Stop Everything
```bash
# Stop Docker containers
docker compose down

# Stop API server
# Press Ctrl+C in the server terminal
```

### Reset Database
```bash
# WARNING: This deletes all data!
docker compose down -v
docker compose up -d
```

---

## 📊 Service Endpoints

| Service | URL | Port | Purpose |
|---------|-----|------|---------|
| **API Server** | http://localhost:3000 | 3000 | REST API + UI |
| **Qdrant** | http://localhost:9200 | 9200 | Vector search |
| **PostgreSQL** | localhost | 5432 | Relational DB |
| **pgAdmin** | http://localhost:5050 | 5050 | DB admin UI |

---

## 🔍 Health Checks

### API Server
```bash
curl http://localhost:3000/api/stats
# Expected: {"total_memories":0,"active_memories":0,"relationships":0}
```

### Qdrant
```bash
curl http://localhost:9200/
# Expected: {"title":"qdrant - vector search engine",...}
```

### PostgreSQL
```bash
docker exec hivemind-postgres pg_isready -U hivemind
# Expected: accepting connections
```

---

## 🚨 Troubleshooting

### Port Already in Use
```bash
# Find what's using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>

# Or change port in .env
PORT=3001
```

### Docker Containers Won't Start
```bash
# Check Docker is running
docker ps

# Check disk space
df -h

# Prune unused containers
docker system prune -a
```

### API Server Crashes
```bash
# Check Node.js version
node --version  # Must be v20+

# Reinstall dependencies
cd core
rm -rf node_modules package-lock.json
npm install

# Check for syntax errors
npm run check
```

### Qdrant Unhealthy
```bash
# Check logs
docker logs hivemind-qdrant

# Restart container
docker compose restart hivemind-qdrant

# Check port mapping
docker port hivemind-qdrant
```

---

## 📁 Project Structure

```
HIVE-MIND/
├── core/                    # Core API server
│   ├── src/
│   │   ├── server.js       # HTTP server
│   │   ├── engine.local.js # Memory engine
│   │   ├── embeddings/     # Embedding services
│   │   ├── vector/         # Qdrant client
│   │   └── ...
│   ├── package.json
│   └── tests/
├── docker-compose.local-stack.yml
├── .env.example
├── .env                    # Your config (not in git)
├── scripts/
│   ├── start-local.sh     # One-command start
│   ├── run-tests.sh       # Test runner
│   ├── validate-docker.sh # Docker validation
│   └── scan-secrets.sh    # Security scan
└── client.html            # Web UI
```

---

## 🔐 Security Best Practices

1. **Never commit `.env`** - It's in `.gitignore`
2. **Rotate keys regularly** - Use `scripts/scan-secrets.sh` to check
3. **Use strong passwords** - Generate with `openssl rand -hex 32`
4. **Run security scans** - `npm audit` in core directory

---

## 📞 Getting Help

- **Documentation:** Check `/docs/` folder
- **Issues:** GitHub Issues
- **Discord:** [Invite link]
- **Email:** support@hivemind.io

---

## ✅ Checklist for New Developers

- [ ] Docker installed and running
- [ ] Node.js v20+ installed
- [ ] Repository cloned
- [ ] `.env` file created with API keys
- [ ] Dependencies installed (`npm install`)
- [ ] Docker stack started (`docker compose up -d`)
- [ ] API server running (`npm run server`)
- [ ] UI accessible at http://localhost:3000
- [ ] Tests passing (`./scripts/run-tests.sh`)

---

*End of Local Runbook*

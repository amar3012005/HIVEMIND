# HIVE-MIND - Local Testing Guide

**Date:** 2026-03-09  
**Purpose:** Test memory engine locally with minimal setup

---

## 🎯 What You Need

### Absolute Minimum
1. **Docker** - To run PostgreSQL with Apache AGE
2. **Groq API Key** - Already configured ✅
3. **Node.js** - To run tests

### That's It!
- ❌ No Qdrant needed (skip vector search for now)
- ❌ No Redis needed (skip caching for now)
- ❌ No Hetzner deployment needed (test locally first)
- ❌ No full framework deployment needed

---

## 🚀 Quick Start (5 minutes)

### Step 1: Start PostgreSQL + Apache AGE

```bash
cd /Users/amar/HIVE-MIND

# Start the database
docker-compose -f docker-compose.test.yml up -d

# Wait for it to be ready (30 seconds)
sleep 30
```

### Step 2: Run Tests

```bash
# Run the end-to-end test suite
node tests/test-memory-engine.js
```

### Step 3: Verify

```bash
# Check if database is running
docker ps | grep hivemind-postgres

# Check PostgreSQL health
docker exec hivemind-postgres pg_isready -U hivemind

# Test API (if server is running)
curl http://localhost:3000/api/memories
```

---

## 📁 Files Created

| File | Purpose |
|------|---------|
| `docker-compose.test.yml` | PostgreSQL + AGE container |
| `tests/test-memory-engine.js` | End-to-end test suite (15 tests) |
| `.env.test` | Environment variables |
| `scripts/test-local.sh` | Automated test script |

---

## 🧪 Test Coverage

The test suite validates:

1. ✅ **Groq API Connectivity** - Situationalization works
2. ✅ **AST Parser** - JavaScript/TypeScript/Python parsing
3. ✅ **Scope Chain** - Class > Method > Block hierarchy
4. ✅ **NWS Density** - Code density calculation
5. ✅ **State Mutator** - isLatest mutation on Updates
6. ✅ **Conflict Resolver** - Duplicate detection
7. ✅ **MCP Bridge** - Endpoint generation
8. ✅ **Memory Engine** - Store/retrieve memories
9. ✅ **Graph Traversal** - Updates/Extends/Derives relationships

---

## 🔧 Alternative: Use Hetzner Cloud

If you prefer to use your Hetzner server:

### On Hetzner Server

```bash
# SSH into server
ssh root@your-hetzner-ip

# Run PostgreSQL container
docker run -d \
  --name hivemind-postgres \
  -p 5432:5432 \
  -e POSTGRES_USER=hivemind \
  -e POSTGRES_PASSWORD=hivemind_dev_password \
  -e POSTGRES_DB=hivemind \
  -v hivemind_data:/var/lib/postgresql/data \
  tonghuikang/apache-age:PG15_1.5.0

# Open port 5432 in firewall
ufw allow 5432/tcp
```

### Locally

```bash
# Set database URL to Hetzner
export DATABASE_URL="postgres://hivemind:hivemind_dev_password@your-hetzner-ip:5432/hivemind"

# Run tests
node tests/test-memory-engine.js
```

---

## 🚨 Troubleshooting

### Database won't start

```bash
# Check logs
docker logs hivemind-postgres

# Remove and recreate
docker-compose -f docker-compose.test.yml down -v
docker-compose -f docker-compose.test.yml up -d
```

### Apache AGE not loaded

```bash
# Verify extension
docker exec hivemind-postgres psql -U hivemind -d hivemind -c "LOAD 'age';"
docker exec hivemind-postgres psql -U hivemind -d hivemind -c "SELECT * FROM ag_catalog.ag_graph;"
```

### Groq API fails

```bash
# 🔴 SECURITY NOTICE: Generate new key at https://console.groq.com/
# Previous key was compromised - see project_status/KEY_ROTATION_RECORD.md
# Test API directly with your new key
curl -X POST https://api.groq.com/openai/v1/chat/completions \
  -H "Authorization: Bearer $GROQ_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"llama-3.3-70b-versatile","messages":[{"role":"user","content":"Test"}]}'
```

### Tests fail

```bash
# Run with verbose output
node --test tests/test-memory-engine.js

# Check environment
cat .env.test
```

---

## 📊 What's Being Tested

| Component | What It Does | Status |
|-----------|-------------|--------|
| PostgreSQL | Database storage | ✅ |
| Apache AGE | Graph relationships | ✅ |
| Groq API | Contextual situationalization | ✅ |
| AST Parser | Code understanding | ✅ |
| State Mutator | Automatic isLatest | ✅ |
| Conflict Resolver | Duplicate detection | ✅ |
| MCP Bridge | Cross-app endpoints | ✅ |
| Memory Engine | Store/retrieve | ✅ |

---

## ✅ Success Criteria

All tests should pass:
- 15/15 tests passing
- No errors in console
- API responds at http://localhost:3000

---

## 🎯 Next Steps After Local Testing

Once local tests pass:

1. **Deploy to Hetzner** - Full production stack
2. **Add Qdrant** - Enable vector search
3. **Add Redis** - Enable caching
4. **Add Monitoring** - Prometheus + Grafana
5. **Cross-platform testing** - ChatGPT ↔ Claude handoff

---

## 📞 Commands Reference

```bash
# Start database
docker-compose -f docker-compose.test.yml up -d

# Stop database
docker-compose -f docker-compose.test.yml down

# View logs
docker logs hivemind-postgres

# Run tests
node tests/test-memory-engine.js

# Run automated script
./scripts/test-local.sh

# Check database
docker exec hivemind-postgres psql -U hivemind -d hivemind -c "SELECT version();"

# Verify Apache AGE
docker exec hivemind-postgres psql -U hivemind -d hivemind -c "LOAD 'age'; SELECT * FROM ag_catalog.ag_graph;"
```

---

*Last updated: 2026-03-09*

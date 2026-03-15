# HIVE-MIND - Qdrant Setup Complete

**Date:** 2026-03-10  
**Status:** ✅ COMPLETE

---

## 🎯 What's Running

| Service | Container | Port | Status |
|---------|-----------|------|--------|
| **PostgreSQL 15** | hivemind-postgres | 5432 | ✅ Healthy |
| **Qdrant 1.12.0** | hivemind-qdrant | 9200 (HTTP), 9201 (gRPC) | ✅ Running |
| **pgAdmin** | hivemind-pgadmin | 5050 | ⚠️ Restarting |

---

## 📦 Qdrant Configuration

### Collection: `hivemind_memories`

| Setting | Value |
|---------|-------|
| **Vector Size** | 1024-dim |
| **Distance** | Cosine |
| **Shards** | 1 |
| **Replication** | 1 |
| **On-disk Payload** | true |

### HNSW Index

| Parameter | Value |
|-----------|-------|
| **m** | 16 |
| **ef_construct** | 100 |
| **full_scan_threshold** | 10000 |
| **on_disk** | true |

### Quantization

| Parameter | Value |
|-----------|-------|
| **Type** | scalar (int8) |
| **Quantile** | 0.99 |
| **Always RAM** | false |

### Payload Indexes (11 fields)

- `user_id` (keyword)
- `org_id` (keyword)
- `project` (keyword)
- `tags` (keyword)
- `is_latest` (bool)
- `created_at` (datetime)
- `document_date` (datetime)
- `content_hash` (keyword)
- `relationship_type` (keyword)
- `importance_score` (float)
- `decay_factor` (float)

---

## 🔑 Embedding Model

**No local embedding model running!**

Using **API-based embeddings**:

| Provider | Model | Dimensions | Cost |
|----------|-------|------------|------|
| **Mistral AI** | `mistral-embed` (BGE-M3) | 1024 | ~$0.04/1M tokens |
| **OpenAI** | `text-embedding-3-large` | 3072 | ~$0.13/1M tokens |
| **Groq** | N/A | N/A | Not available |

### Configuration

```bash
# .env file
MISTRAL_API_KEY=your-mistral-api-key-here
MISTRAL_EMBEDDING_MODEL=mistral-embed

# Or OpenAI
OPENAI_API_KEY=your-openai-api-key-here
OPENAI_EMBEDDING_MODEL=text-embedding-3-large
```

---

## 🚀 Quick Start

### Start Services

```bash
cd /Users/amar/HIVE-MIND

# Start PostgreSQL + Qdrant
docker-compose -f docker-compose.local-stack.yml up -d

# Wait for health check
sleep 10

# Verify
docker ps --filter "name=hivemind"
```

### Access

| Service | URL | Credentials |
|---------|-----|-------------|
| **PostgreSQL** | localhost:5432 | hivemind / hivemind_dev_password |
| **Qdrant** | http://localhost:9200 | API key: dev_api_key_hivemind_2026 |
| **Qdrant Dashboard** | http://localhost:9200/dashboard | - |
| **pgAdmin** | http://localhost:5050 | admin@hivemind.local / admin_password |

### Test Connection

```bash
# Qdrant health
curl http://localhost:9200/

# List collections
curl http://localhost:9200/collections

# PostgreSQL
docker exec hivemind-postgres psql -U hivemind -c "SELECT version();"
```

---

## 📊 Multi-Tenancy Setup

### Current Configuration: Single Collection + Filters

```yaml
Collection: hivemind_memories
├── Filter by user_id
├── Filter by org_id
└── Filter by project
```

**Best for:** <1000 users

**Query Example:**
```json
POST http://localhost:9200/collections/hivemind_memories/points/search
{
  "vector": [0.12, -0.45, ...],
  "filter": {
    "must": [
      { "key": "user_id", "match": { "value": "user-123" } },
      { "key": "is_latest", "match": { "value": true } }
    ]
  },
  "limit": 10,
  "score_threshold": 0.7
}
```

---

## 💰 Cost Estimation

### API Embedding Costs (Mistral AI)

| Usage | Tokens/Month | Cost/Month |
|-------|--------------|------------|
| Light (100 memories/day) | ~1M | ~$0.04 |
| Medium (1K memories/day) | ~10M | ~$0.40 |
| Heavy (10K memories/day) | ~100M | ~$4.00 |
| Enterprise (100K/day) | ~1B | ~$40.00 |

### Infrastructure Costs (Hetzner)

| Component | Spec | Cost/Month |
|-----------|------|------------|
| **Server** | CX22 (2 vCPU, 4GB RAM) | ~€5 |
| **PostgreSQL** | Included | €0 |
| **Qdrant** | Docker container | €0 |
| **Total** | | **~€5/month** |

---

## 🔧 Configuration Files

| File | Purpose |
|------|---------|
| `docker-compose.local-stack.yml` | PostgreSQL + Qdrant setup |
| `infra/qdrant/config.yaml` | Qdrant production config |
| `infra/postgres/init-age.sql` | PostgreSQL initialization |
| `scripts/setup-qdrant.js` | Collection setup script |
| `.env.test` | Environment variables |

---

## ✅ What's Complete

- [x] PostgreSQL 15 running
- [x] Qdrant 1.12.0 running
- [x] Collection `hivemind_memories` created
- [x] 1024-dim vector configuration
- [x] 11 payload indexes created
- [x] HNSW index configured
- [x] Quantization enabled (int8)
- [x] API key authentication
- [x] Health checks configured

---

## 📝 Next Steps

1. **Get Mistral AI API Key** - https://console.mistral.ai/
2. **Configure .env** - Add `MISTRAL_API_KEY`
3. **Test embedding** - Run `node scripts/setup-qdrant.js`
4. **Start HIVE-MIND server** - `cd core && node src/server.js`
5. **Test end-to-end** - Store and recall memories

---

## 🚨 Troubleshooting

### Qdrant won't start
```bash
docker logs hivemind-qdrant
docker-compose -f docker-compose.local-stack.yml restart qdrant
```

### Port conflict
```bash
# Change port in docker-compose.local-stack.yml
ports:
  - "9200:6333"  # Change 9200 to any available port
```

### Embedding API fails
```bash
# Test Mistral API
curl -X POST https://api.mistral.ai/v1/embeddings \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"model":"mistral-embed","input":["test"]}'
```

---

*Last updated: 2026-03-10*

---
name: qdrant-ops
description: Qdrant Cloud vector database operations - health checks, backups, repairs, and vector management
type: reference
---

# Qdrant Operations Skill

## Overview
Manage the Qdrant Cloud vector database for HIVEMIND semantic search and memory storage.

## Configuration

**Qdrant Cloud**:
- **URL**: `https://24826665-41d6-4ea6-b13f-fc42438c4c55.eu-central-1-0.aws.cloud.qdrant.io:6333`
- **Collection**: `BUNDB AGENT`
- **Vector Size**: 384 (all-MiniLM-L6-v2)
- **Distance**: Cosine

## Commands

### `/qdrant status`
Check collection health and statistics.

**API Call**:
```bash
curl -X GET "https://24826665-41d6-4ea6-b13f-fc42438c4c55.eu-central-1-0.aws.cloud.qdrant.io:6333/collections/BUNDB%20AGENT" \
  -H "api-key: $QDRANT_API_KEY"
```

**Expected Response**:
```json
{
  "result": {
    "status": "green",
    "points_count": <number>,
    "vectors_count": <number>,
    "config": {
      "params": {
        "vectors": {
          "size": 384,
          "distance": "Cosine"
        }
      }
    }
  }
}
```

### `/qdrant vectors`
Show vector statistics and recent additions.

**Workflow**:
1. Get collection stats
2. List recent points (last 10)
3. Show vector dimension distribution
4. Check for orphaned vectors (no PostgreSQL record)

### `/qdrant backup`
Backup vectors to local storage.

**Workflow**:
1. Export all points from collection
2. Save to `/opt/HIVEMIND/backups/qdrant-backup-{date}.json`
3. Verify backup integrity
4. Upload to S3 (if configured)

**Command**:
```bash
curl -X POST "https://24826665-41d6-4ea6-b13f-fc42438c4c55.eu-central-1-0.aws.cloud.qdrant.io:6333/collections/BUNDB%20AGENT/points/scroll" \
  -H "api-key: $QDRANT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"limit": 1000, "with_payload": true, "with_vector": true}'
```

### `/qdrant repair`
Fix common collection issues.

**Issues Fixed**:
- Orphaned vectors (in Qdrant but not PostgreSQL)
- Missing vectors (in PostgreSQL but not Qdrant)
- Dimension mismatches

**Workflow**:
1. Compare PostgreSQL memories with Qdrant points
2. Identify mismatches
3. Sync missing vectors
4. Remove orphaned vectors
5. Verify consistency

### `/qdrant test-embedding`
Verify embedding pipeline is working.

**Test**:
```bash
# Save a test memory
curl -X POST "http://localhost:3000/api/memories" \
  -H "X-API-Key: hm_master_key_99228811" \
  -d '{"content": "Test memory for embedding verification"}'

# Check it appears in Qdrant
curl -X GET "https://24826665-41d6-4ea6-b13f-fc42438c4c55.eu-central-1-0.aws.cloud.qdrant.io:6333/collections/BUNDB%20AGENT/points/{memory_id}" \
  -H "api-key: $QDRANT_API_KEY"
```

## Troubleshooting

### Issue: Vectors not saving to Qdrant

**Symptoms**:
- Memory saves to PostgreSQL but not Qdrant
- Logs show "Embedding failed" errors

**Causes**:
1. Hetzner embedding service unreachable
2. SSL certificate mismatch
3. Qdrant collection doesn't exist

**Fix**:
```bash
# 1. Check embedding service
docker exec s0k0s0k40wo44w4w8gcs8ow0-230246199607 \
  curl -k -X POST "https://embeddings-eu-...:4006/embed" \
  -d '{"sentences": ["test"]}'

# 2. Check Qdrant collection exists
curl -X GET "https://.../collections/BUNDB%20AGENT" \
  -H "api-key: $QDRANT_API_KEY"

# 3. Check server logs for errors
docker logs s0k0s0k40wo44w4w8gcs8ow0-230246199607 | grep -E "Qdrant|Embedding"
```

### Issue: Collection not found

**Symptoms**:
- "Collection `BUNDB AGENT` doesn't exist!"

**Fix**:
```bash
# Create collection with correct dimensions
curl -X PUT "https://.../collections/BUNDB%20AGENT" \
  -H "api-key: $QDRANT_API_KEY" \
  -d '{
    "vectors": {
      "size": 384,
      "distance": "Cosine"
    }
  }'
```

### Issue: Dimension mismatch

**Symptoms**:
- "Expected vector of size 384, got 1024"

**Fix**:
1. Check `EMBEDDING_DIMENSION=384` in .env
2. Check qdrant-client.js uses correct dimension
3. Re-embed existing vectors if dimension changed

## Monitoring

### Health Check Script
```bash
#!/bin/bash
# /opt/HIVEMIND/.claude/scripts/qdrant-health.sh

QDRANT_URL="https://24826665-41d6-4ea6-b13f-fc42438c4c55.eu-central-1-0.aws.cloud.qdrant.io:6333"
QDRANT_API_KEY="$QDRANT_API_KEY"
COLLECTION="BUNDB AGENT"

response=$(curl -s -X GET "$QDRANT_URL/collections/$COLLECTION" \
  -H "api-key: $QDRANT_API_KEY")

status=$(echo "$response" | jq -r '.result.status')
points=$(echo "$response" | jq -r '.result.points_count')

if [ "$status" = "green" ]; then
  echo "✅ Qdrant healthy: $points vectors"
  exit 0
else
  echo "❌ Qdrant unhealthy: status=$status"
  exit 1
fi
```

## Key Files

| File | Purpose |
|------|---------|
| `/opt/HIVEMIND/core/src/vector/qdrant-client.js` | Qdrant client |
| `/opt/HIVEMIND/core/src/embeddings/mistral.js` | Embedding service |
| `/data/coolify/applications/.../.env` | Qdrant config |

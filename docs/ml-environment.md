# HIVE-MIND ML Environment Configuration

## Overview

This document describes the environment variables required for HIVE-MIND's ML components.

## Qdrant Configuration

```bash
# Qdrant Cloud Connection
QDRANT_URL=https://hivemind-fr-par-1.cloud.qdrant.io
QDRANT_API_KEY=<your-qdrant-api-key>

# Qdrant Region (for data residency)
QDRANT_REGION=fr-par-1
```

## Mistral-Embed Configuration

```bash
# Mistral API Key
MISTRAL_API_KEY=<your-mistral-api-key>

# Mistral Model
MISTRAL_MODEL=mistral-embed

# Mistral Endpoint (EU data residency)
MISTRAL_ENDPOINT=https://api.mistral.ai/v1

# Batch Processing
MISTRAL_BATCH_SIZE=100
MISTRAL_MAX_RETRIES=3
```

## Embedding Cache Configuration

```bash
# Cache TTL (seconds)
EMBEDDING_CACHE_TTL=86400

# Cache Max Size
EMBEDDING_CACHE_MAX_SIZE=100000

# Cache Key Prefix
EMBEDDING_CACHE_PREFIX=mistral:embed:
```

## Recall Scoring Configuration

```bash
# Weight Configuration (must sum to 1.0)
RECALL_VECTOR_WEIGHT=0.4
RECALL_RECENCY_WEIGHT=0.3
RECALL_IMPORTANCE_WEIGHT=0.2
RECALL_EBBINGHAUS_WEIGHT=0.1

# Recency Configuration
RECALL_RECENCY_HALF_LIFE_DAYS=30
RECALL_RECENCY_BIAS=0.7

# Ebbinghaus Configuration
EBBINGHAUS_HALF_LIFE_DAYS=7
EBBINGHAUS_MAX_STRENGTH=10.0
EBBINGHAUS_DECAY_RATE=0.142857
EBBINGHAUS_RECALL_BOOST=0.15
EBBINGHAUS_CONFIRM_BOOST=0.30
```

## Ebbinghaus Decay Configuration

```bash
# Archive Thresholds
DECAY_ARCHIVE_STRENGTH=0.05
DECAY_ARCHIVE_DAYS=365
DECAY_DELETE_DAYS=730

# Batch Processing
DECAY_BATCH_SIZE=1000
DECAY_DRY_RUN=false
DECAY_NOTIFY=true
```

## Hybrid Search Configuration

```bash
# Search Weights
SEARCH_VECTOR_WEIGHT=0.6
SEARCH_KEYWORD_WEIGHT=0.3
SEARCH_GRAPH_WEIGHT=0.1

# Search Limits
SEARCH_VECTOR_TOP_K=50
SEARCH_KEYWORD_TOP_K=50
SEARCH_GRAPH_TOP_K=20
SEARCH_FINAL_LIMIT=20

# Minimum Score Threshold
SEARCH_MIN_SCORE=0.2
```

## Performance Configuration

```bash
# Latency Targets (milliseconds)
P99_EMBEDDING_LATENCY=500
P99_BATCH_EMBEDDING_LATENCY=5000
P99_VECTOR_SEARCH_LATENCY=100
P99_RECALL_SCORING_LATENCY=200

# Cache Targets
CACHE_HIT_RATE_TARGET=0.8

# Quality Targets
NDCG_TARGET=0.8
MRR_TARGET=0.6
PRECISION_TARGET=0.7
```

## Logging Configuration

```bash
# Log Level
LOG_LEVEL=INFO

# Log Format
LOG_FORMAT=json
```

## Example .env File

```bash
# Qdrant Cloud
QDRANT_URL=https://hivemind-fr-par-1.cloud.qdrant.io
QDRANT_API_KEY=your-qdrant-api-key-here

# Mistral AI (EU Data Residency)
MISTRAL_API_KEY=your-mistral-api-key-here
MISTRAL_MODEL=mistral-embed
MISTRAL_ENDPOINT=https://api.mistral.ai/v1
MISTRAL_BATCH_SIZE=100
MISTRAL_MAX_RETRIES=3

# Embedding Cache
EMBEDDING_CACHE_TTL=86400
EMBEDDING_CACHE_MAX_SIZE=100000

# Recall Scoring Weights
RECALL_VECTOR_WEIGHT=0.4
RECALL_RECENCY_WEIGHT=0.3
RECALL_IMPORTANCE_WEIGHT=0.2
RECALL_EBBINGHAUS_WEIGHT=0.1

# Recency Configuration
RECALL_RECENCY_HALF_LIFE_DAYS=30
RECALL_RECENCY_BIAS=0.7

# Ebbinghaus Configuration
EBBINGHAUS_HALF_LIFE_DAYS=7
EBBINGHAUS_MAX_STRENGTH=10.0
EBBINGHAUS_DECAY_RATE=0.142857
EBBINGHAUS_RECALL_BOOST=0.15
EBBINGHAUS_CONFIRM_BOOST=0.30

# Archive Thresholds
DECAY_ARCHIVE_STRENGTH=0.05
DECAY_ARCHIVE_DAYS=365
DECAY_DELETE_DAYS=730

# Batch Processing
DECAY_BATCH_SIZE=1000
DECAY_DRY_RUN=false
DECAY_NOTIFY=true

# Search Configuration
SEARCH_VECTOR_WEIGHT=0.6
SEARCH_KEYWORD_WEIGHT=0.3
SEARCH_GRAPH_WEIGHT=0.1
SEARCH_MIN_SCORE=0.2

# Performance Targets
P99_EMBEDDING_LATENCY=500
P99_VECTOR_SEARCH_LATENCY=100
P99_RECALL_SCORING_LATENCY=200
CACHE_HIT_RATE_TARGET=0.8

# Logging
LOG_LEVEL=INFO
LOG_FORMAT=json
```

## Running the Decay Job

```bash
# Production run
node scripts/decay-job.js

# Dry run (no changes)
DECAY_DRY_RUN=true node scripts/decay-job.js

# Verbose logging
LOG_LEVEL=debug node scripts/decay-job.js
```

## Qdrant Initialization

```bash
# Initialize Qdrant collections
bash scripts/init-qdrant.sh

# Check health
bash scripts/init-qdrant.sh --health

# Setup only
bash scripts/init-qdrant.sh --setup

# Verify setup
bash scripts/init-qdrant.sh --verify
```

## Environment Variable Validation

All required environment variables must be set before running ML components:

```bash
# Check required variables
if [ -z "$QDRANT_URL" ]; then
  echo "ERROR: QDRANT_URL is required"
  exit 1
fi

if [ -z "$QDRANT_API_KEY" ]; then
  echo "ERROR: QDRANT_API_KEY is required"
  exit 1
fi

if [ -z "$MISTRAL_API_KEY" ]; then
  echo "ERROR: MISTRAL_API_KEY is required"
  exit 1
fi
```

## EU Data Residency Compliance

All ML components are configured for EU data residency:

- **Qdrant**: FR-Paris region only
- **Mistral AI**: EU endpoint
- **PostgreSQL**: DE/FR/FI regions

Verify data residency by checking:
```bash
QDRANT_URL=https://hivemind-fr-par-1.cloud.qdrant.io
MISTRAL_ENDPOINT=https://api.mistral.ai/v1
```

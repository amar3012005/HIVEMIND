# Three-Tier Retrieval Architecture API Documentation

This document describes the Three-Tier Retrieval Architecture implemented in HIVE-MIND, inspired by MiroFish's multi-dimensional search system.

## Overview

The Three-Tier Retrieval Architecture provides three levels of search depth:

1. **QuickSearch** - Fast semantic search for immediate results
2. **PanoramaSearch** - Comprehensive search including historical/expired content
3. **InsightForge** - Deep multi-dimensional analysis with LLM-powered insights

## API Endpoints

### 1. QuickSearch

Fast semantic search optimized for speed and immediate results.

**Endpoint:** `POST /api/search/quick`

**Request Body:**
```json
{
  "query": "string (required) - Search query",
  "memory_type": "string (optional) - Filter by memory type",
  "tags": ["array", "of", "strings"] (optional) - Filter by tags,
  "source_platform": "string (optional) - Filter by source platform",
  "limit": 10 (optional) - Maximum results (default: 10),
  "score_threshold": 0.3 (optional) - Minimum score threshold
}
```

**Response:**
```json
{
  "tier": "quick",
  "query": "original query",
  "results": [
    {
      "id": "memory-id",
      "content": "memory content",
      "score": 0.85,
      "scoreBreakdown": {
        "vector": 0.51,
        "keyword": 0.18,
        "graph": 0.05
      }
    }
  ],
  "metadata": {
    "requestId": "uuid",
    "durationMs": 45,
    "totalFound": 25,
    "returnedCount": 10,
    "scoreThreshold": 0.3,
    "timestamp": "2026-03-15T10:30:00.000Z"
  }
}
```

**Features:**
- Direct vector + keyword search
- Limit: 10 results (configurable)
- Excludes expired content by default
- Depth: shallow (fastest)
- Target latency: <100ms

---

### 2. PanoramaSearch

Comprehensive search including expired and historical content with temporal categorization.

**Endpoint:** `POST /api/search/panorama`

**Request Body:**
```json
{
  "query": "string (required) - Search query",
  "include_expired": true (optional) - Include expired content (default: true),
  "include_historical": true (optional) - Include historical versions (default: true),
  "date_range": {
    "start": "2026-01-01T00:00:00Z",
    "end": "2026-12-31T23:59:59Z"
  } (optional) - Date range filter,
  "temporal_status": "active" (optional) - Filter by status: active, expired, historical, archived,
  "limit": 50 (optional) - Maximum results (default: 50),
  "include_timeline": true (optional) - Include timeline view (default: true)
}
```

**Response:**
```json
{
  "tier": "panorama",
  "query": "original query",
  "results": [...],
  "categories": {
    "active": [...],
    "expired": [...],
    "historical": [...],
    "archived": [...]
  },
  "timeline": {
    "byDate": { "2026-03-15": [...] },
    "byMonth": { "2026-03": [...] },
    "byYear": { "2026": [...] },
    "chronological": [...],
    "reverseChronological": [...],
    "summary": {
      "totalEvents": 50,
      "dateRange": {
        "start": "2026-01-01T00:00:00.000Z",
        "end": "2026-03-15T10:30:00.000Z",
        "span": 73
      },
      "peakDays": [
        { "date": "2026-03-10", "count": 5 }
      ]
    }
  },
  "statistics": {
    "byCategory": {
      "active": { "count": 30, "avgScore": 0.72 },
      "expired": { "count": 10, "avgScore": 0.58 },
      "historical": { "count": 8, "avgScore": 0.45 },
      "archived": { "count": 2, "avgScore": 0.32 }
    },
    "temporalDistribution": {
      "lastWeek": 5,
      "lastMonth": 15,
      "lastQuarter": 30,
      "lastYear": 45,
      "older": 5
    },
    "scoreDistribution": {
      "0.0-0.2": 2,
      "0.2-0.4": 5,
      "0.4-0.6": 10,
      "0.6-0.8": 20,
      "0.8-1.0": 13
    },
    "timeRange": {
      "start": "2026-01-01T00:00:00.000Z",
      "end": "2026-03-15T10:30:00.000Z",
      "span": 73
    }
  },
  "metadata": {
    "requestId": "uuid",
    "durationMs": 150,
    "totalFound": 100,
    "returnedCount": 50,
    "includeExpired": true,
    "includeHistorical": true,
    "timestamp": "2026-03-15T10:30:00.000Z"
  }
}
```

**Features:**
- Include all content including expired/historical
- Limit: 50 results (configurable)
- Categorizes by temporal status
- Timeline view
- Full-depth graph traversal
- Target latency: <500ms

---

### 3. InsightForge

Deep multi-dimensional analysis using LLM-powered sub-query generation.

**Endpoint:** `POST /api/search/insight`

**Request Body:**
```json
{
  "query": "string (required) - Search query",
  "simulation_requirement": "string (optional) - Additional context for analysis",
  "sub_query_limit": 5 (optional) - Maximum sub-queries (default: 5),
  "results_per_sub_query": 15 (optional) - Results per sub-query (default: 15),
  "include_analysis": true (optional) - Include LLM synthesis (default: true)
}
```

**Response:**
```json
{
  "tier": "insight",
  "query": "original query",
  "subQueries": [
    {
      "id": "sq-1",
      "query": "specific sub-query",
      "focus": "aspect this covers",
      "weight": 0.25,
      "reasoning": "explanation"
    }
  ],
  "results": [...],
  "semanticFacts": [
    {
      "fact": "extracted fact",
      "confidence": 0.85,
      "supportingMemories": ["id1", "id2"],
      "category": "fact",
      "extractedAt": "2026-03-15T10:30:00.000Z"
    }
  ],
  "entityInsights": [
    {
      "id": "entity-abc123",
      "name": "Entity Name",
      "type": "person",
      "confidence": 0.9,
      "mentions": 5,
      "attributes": {},
      "relatedEntities": ["entity2", "entity3"],
      "extractedAt": "2026-03-15T10:30:00.000Z"
    }
  ],
  "relationshipChains": [
    {
      "id": "chain-1",
      "from": { "entity" },
      "to": { "entity" },
      "relationship": "type",
      "confidence": 0.8,
      "path": ["Entity1", "relationship", "Entity2"],
      "evidence": {}
    }
  ],
  "synthesis": {
    "semanticFacts": [...],
    "patterns": [
      {
        "pattern": "description",
        "evidence": "supporting evidence",
        "significance": "why this matters"
      }
    ],
    "insights": [
      {
        "insight": "key insight",
        "relevance": 0.9,
        "explanation": "detailed explanation"
      }
    ],
    "gaps": ["missing information"]
  },
  "metadata": {
    "requestId": "uuid",
    "durationMs": 2500,
    "subQueryCount": 5,
    "totalRawResults": 75,
    "uniqueResults": 45,
    "entityCount": 12,
    "chainCount": 8,
    "timestamp": "2026-03-15T10:30:00.000Z"
  }
}
```

**Features:**
- LLM-powered sub-query generation
- Multi-dimensional result aggregation
- Entity extraction and linking
- Relationship chain building
- Semantic fact extraction
- Pattern and insight synthesis
- Target latency: <3s

**Requirements:**
- Groq API key configured (GROQ_API_KEY)

---

### 4. Compare Tiers

Compare results across all three tiers for the same query.

**Endpoint:** `POST /api/search/compare`

**Request Body:**
```json
{
  "query": "string (required) - Search query",
  "tier": "auto" (optional) - Tier selection strategy
}
```

**Response:**
```json
{
  "requestId": "uuid",
  "query": "original query",
  "tiers": {
    "quick": {
      "success": true,
      "durationMs": 45,
      "resultCount": 10,
      "topScore": 0.92
    },
    "panorama": {
      "success": true,
      "durationMs": 150,
      "resultCount": 50,
      "categories": ["active", "expired", "historical"]
    },
    "insight": {
      "success": true,
      "durationMs": 2500,
      "subQueryCount": 5,
      "entityCount": 12
    }
  },
  "totalDurationMs": 2700,
  "timestamp": "2026-03-15T10:30:00.000Z"
}
```

---

## Usage Examples

### QuickSearch Example

```bash
curl -X POST http://localhost:3000/api/search/quick \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "query": "machine learning projects",
    "memory_type": "project",
    "tags": ["ai", "ml"],
    "limit": 5
  }'
```

### PanoramaSearch Example

```bash
curl -X POST http://localhost:3000/api/search/panorama \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "query": "project evolution",
    "include_expired": true,
    "include_historical": true,
    "date_range": {
      "start": "2025-01-01T00:00:00Z",
      "end": "2026-12-31T23:59:59Z"
    },
    "include_timeline": true
  }'
```

### InsightForge Example

```bash
curl -X POST http://localhost:3000/api/search/insight \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer YOUR_API_KEY" \
  -d '{
    "query": "analyze the relationship between AI adoption and productivity",
    "simulation_requirement": "Focus on enterprise implementations",
    "sub_query_limit": 7,
    "include_analysis": true
  }'
```

---

## Error Handling

All endpoints return consistent error responses:

```json
{
  "error": "Error type",
  "message": "Human-readable error message",
  "requestId": "uuid-for-tracing",
  "details": {} (optional)
}
```

**HTTP Status Codes:**
- `200` - Success
- `400` - Bad Request (validation error)
- `401` - Unauthorized (missing/invalid API key)
- `403` - Forbidden (insufficient permissions)
- `404` - Not Found
- `500` - Internal Server Error
- `503` - Service Unavailable (e.g., LLM not configured)

---

## Performance Considerations

| Tier | Target Latency | Use Case |
|------|---------------|----------|
| QuickSearch | <100ms | Real-time suggestions, immediate results |
| PanoramaSearch | <500ms | Historical analysis, comprehensive view |
| InsightForge | <3s | Deep analysis, research, pattern discovery |

---

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    Three-Tier Retrieval                      │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ QuickSearch  │  │PanoramaSearch│  │ InsightForge │      │
│  │   (Tier 1)   │  │   (Tier 2)   │  │   (Tier 3)   │      │
│  └──────┬───────┘  └──────┬───────┘  └──────┬───────┘      │
│         │                 │                 │               │
│    <100ms            <500ms             <3s                 │
│         │                 │                 │               │
│    Shallow            Full              Deep                │
│    Search            Search            Analysis              │
│         │                 │                 │               │
│    ┌────┴────┐       ┌───┴───┐      ┌─────┴──────┐         │
│    │Vector + │       │Vector +│      │LLM Sub-    │         │
│    │Keyword  │       │Keyword +│     │Query Gen   │         │
│    │         │       │Graph   │      │            │         │
│    │No Expired│      │Include │      │Entity      │         │
│    │         │       │Expired │      │Extraction  │         │
│    └─────────┘       │+ History│      │Relationship│         │
│                      └────────┘      │Chains      │         │
│                                      └────────────┘         │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Implementation Files

- `/src/search/three-tier-retrieval.js` - Main orchestration class
- `/src/search/quick-search.js` - QuickSearch implementation (in three-tier-retrieval.js)
- `/src/search/panorama-search.js` - PanoramaSearch implementation
- `/src/search/insight-forge.js` - InsightForge LLM analysis
- `/src/search/hybrid.js` - Enhanced with temporal filters
- `/core/src/server.js` - API endpoints

---

## Configuration

Environment variables:

```bash
# Groq API (required for InsightForge)
GROQ_API_KEY=your-groq-api-key
GROQ_INFERENCE_MODEL=llama-3.3-70b-versatile

# Search defaults
HIVEMIND_SEARCH_DEFAULT_LIMIT=20
HIVEMIND_SEARCH_MAX_LIMIT=100
```

---

## See Also

- [MiroFish Integration Plan](../.claude/plans/mirofish-integration-plan.md)
- [Hybrid Search Documentation](./hybrid-search.md)
- [API Authentication](./api-authentication.md)

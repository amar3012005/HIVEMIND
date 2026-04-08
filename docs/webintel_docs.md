# HIVEMIND Web Intelligence - Developer Documentation

**Version:** 2.0 (Tavily-Enabled)  
**Last Updated:** 2026-04-07  
**Status:** Production-Ready

---

## Table of Contents

1. [Overview](#overview)
2. [Architecture](#architecture)
3. [Runtime Chain](#runtime-chain)
4. [API Reference](#api-reference)
5. [MCP Tools](#mcp-tools)
6. [Frontend Integration](#frontend-integration)
7. [Safety & Policy Layer](#safety--policy-layer)
8. [Rate Limits & Quotas](#rate-limits--quotas)
9. [Telemetry & Monitoring](#telemetry--monitoring)
10. [Error Handling](#error-handling)
11. [Configuration](#configuration)
12. [Deep Research Integration](#deep-research-integration)

---

## Overview

HIVEMIND Web Intelligence provides production-grade web search, crawling, and content extraction capabilities through a unified async job-based API. The system uses a three-tier runtime chain with automatic fallback for maximum reliability.

### Key Features

- **Web Search:** AI-optimized search with relevance scoring, answers, and structured results
- **Web Crawl:** Graph-based website traversal with configurable depth and breadth
- **URL Extract:** Multi-URL content extraction with JS rendering support
- **Domain Filtering:** Restrict searches to specific domains or exclude unwanted sources
- **Content Policy:** Built-in safety layer blocking adult content, malware, and private networks
- **Async Jobs:** Non-blocking execution with polling-based status checks
- **Save to Memory:** One-click persistence of web results to HIVEMIND memory graph

### Primary Use Cases

1. **User-Facing Web Intelligence UI** - Interactive search/crawl interface at `/hivemind/app`
2. **Deep Research Engine** - Automated web search for research sessions
3. **MCP Tools** - `hivemind_web_search` and `hivemind_web_crawl` for AI agents
4. **Memory Ingestion** - Save web findings to persistent memory with tags

---

## Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                    HIVEMIND Web Intelligence                     │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  ┌──────────────┐   ┌──────────────┐   ┌──────────────┐        │
│  │   Frontend   │   │   MCP Tools  │   │Deep Research │        │
│  │  (React UI)  │   │  (hivemind_*)│   │  (Researcher)│        │
│  └──────┬───────┘   └──────┬───────┘   └──────┬───────┘        │
│         │                  │                  │                 │
│         └──────────────────┼──────────────────┘                 │
│                            │                                     │
│                     ┌──────▼───────┐                            │
│                     │  API Layer   │                            │
│                     │ /api/web/*   │                            │
│                     └──────┬───────┘                            │
│                            │                                     │
│         ┌──────────────────┼──────────────────┐                 │
│         │                  │                  │                 │
│  ┌──────▼───────┐   ┌──────▼───────┐   ┌──────▼───────┐        │
│  │  WebJobStore │   │ BrowserRuntime│  │ WebPolicy    │        │
│  │  (JSON/DB)   │   │  (Facade)     │  │ (Safety)     │        │
│  └──────────────┘   └──────┬───────┘   └──────────────┘        │
│                            │                                     │
│         ┌──────────────────┼──────────────────┐                 │
│         │                  │                  │                 │
│  ┌──────▼───────┐   ┌──────▼───────┐   ┌──────▼───────┐        │
│  │ TavilyRuntime│   │LightPanda    │   │ FetchFallback│        │
│  │  (Primary)   │   │  (Secondary) │   │  (Last resort)│       │
│  └──────────────┘   └──────────────┘   └──────────────┘        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Core Modules

| Module | Path | Responsibility |
|--------|------|----------------|
| `server.js` | `core/src/server.js` | HTTP endpoints, job orchestration |
| `browser-runtime.js` | `core/src/web/browser-runtime.js` | Runtime facade with fallback chain |
| `tavily-client.js` | `core/src/web/tavily-client.js` | Tavily API wrapper |
| `web-job-store.js` | `core/src/web/web-job-store.js` | Async job persistence |
| `web-policy.js` | `core/src/web/web-policy.js` | Domain validation, content filtering |
| `WebIntelligence.jsx` | `frontend/.../pages/WebIntelligence.jsx` | React UI |
| `hosted-service.js` | `core/src/mcp/hosted-service.js` | MCP tool definitions |
| `researcher.js` | `core/src/deep-research/researcher.js` | Deep Research integration |

---

## Runtime Chain

The system uses a three-tier fallback architecture for maximum reliability:

### Tier 1: TavilyRuntime (Primary)

**When:** Default for all requests  
**Capabilities:**
- Search with AI-generated answers
- Domain filtering (exact match)
- Time-range filtering
- Content scoring (0.99+ relevance)
- Favicon extraction
- Image extraction
- Multi-URL extract (up to 20 URLs)
- Graph-based crawl (depth 1-5)

**Response Format:**
```json
{
  "results": [
    {
      "title": "Page Title",
      "url": "https://example.com",
      "content": "Snippet text...",
      "score": 0.9998,
      "favicon": "https://...",
      "images": []
    }
  ],
  "answer": "AI-generated answer (if requested)",
  "runtime_used": "tavily",
  "fallback_applied": false,
  "credits_used": 1
}
```

### Tier 2: LightPandaRuntime (Secondary)

**When:** Tavily unavailable or blocked  
**Capabilities:**
- Multi-engine search (DuckDuckGo + Qwant)
- Domain authority scoring (heuristic)
- OpenGraph metadata extraction
- JSON-LD structured data parsing
- Browser-based rendering via CDP

### Tier 3: FetchFallbackRuntime (Last Resort)

**When:** Both Tavily and LightPanda fail  
**Capabilities:**
- Direct HTTP fetch with HTML parsing
- Metadata extraction (title, description)
- Favicon via Google's service
- Quality scoring based on content completeness
- Word count and reading time estimation

**Response Format:**
```json
{
  "results": [
    {
      "url": "https://example.com",
      "title": "Page Title",
      "snippet": "Description...",
      "favicon": "https://www.google.com/s2/favicons?domain=...",
      "score": 0.5,
      "domainAuthority": 0.5,
      "wordCount": 350,
      "readingTime": 2,
      "qualityScore": 0.6
    }
  ],
  "runtime_used": "fetch",
  "fallback_applied": true
}
```

---

## API Reference

### Base URL
```
Production: https://core.hivemind.davinciai.eu:8050
Local:      http://localhost:3001
```

### Authentication

All endpoints require authentication via:
- `Authorization: Bearer <api_key>` header, or
- `X-API-Key: <api_key>` header

API keys are generated via `/api/admin/api-keys` (admin endpoint).

---

### POST /api/web/search/jobs

Submit a web search job.

**Request Body:**
```json
{
  "query": "artificial intelligence breakthroughs",
  "domains": ["wikipedia.org", "arxiv.org"],  // Optional
  "limit": 10  // Optional, default: 10, max: 20
}
```

**Response (202 Accepted):**
```json
{
  "job_id": "495659a3-eb4e-4506-beeb-063c4e694d44",
  "status": "queued",
  "type": "search"
}
```

---

### POST /api/web/crawl/jobs

Submit a web crawl job.

**Request Body:**
```json
{
  "urls": ["https://example.com"],
  "depth": 1,      // Optional, default: 1, max: 3
  "pageLimit": 10  // Optional, default: 50, max: 500
}
```

**Response (202 Accepted):**
```json
{
  "job_id": "b7060816-9fa8-46b5-abf2-e53d607487cc",
  "status": "queued",
  "type": "crawl"
}
```

---

### GET /api/web/jobs/:jobId

Poll job status and retrieve results.

**Response (Success):**
```json
{
  "id": "495659a3-eb4e-4506-beeb-063c4e694d44",
  "type": "search",
  "status": "succeeded",
  "params": {
    "query": "artificial intelligence",
    "domains": [],
    "limit": 10
  },
  "results": [
    {
      "title": "...",
      "url": "...",
      "snippet": "...",
      "score": 0.99,
      "favicon": "..."
    }
  ],
  "userId": "00000000-0000-4000-8000-000000000001",
  "orgId": "00000000-0000-4000-8000-000000000002",
  "runtime_used": "tavily",
  "fallback_applied": false,
  "duration_ms": 1234,
  "pages_processed": 0,
  "created_at": "2026-04-07T10:00:00.000Z",
  "updated_at": "2026-04-07T10:00:01.234Z"
}
```

**Job States:**
- `queued` - Job submitted, waiting to be processed
- `running` - Job in progress
- `succeeded` - Job completed with results
- `failed` - Job failed (check `error` field)

---

### GET /api/web/jobs/:jobId/retry

Retry a failed job.

**Response (202 Accepted):**
```json
{
  "job_id": "new-job-id",
  "status": "queued",
  "type": "search",
  "retried_from": "original-job-id"
}
```

---

### POST /api/web/jobs/:jobId/save-to-memory

Save job results to HIVEMIND memory.

**Request Body:**
```json
{
  "resultIndex": 0,      // Optional, saves all if omitted
  "title": "Custom title",  // Optional
  "tags": ["web-search", "ai"]  // Optional
}
```

**Response (200 OK):**
```json
{
  "saved": [
    {
      "memoryId": "uuid",
      "title": "...",
      "tags": ["web-search", "ai"]
    }
  ]
}
```

---

### GET /api/web/usage

Get current user's web intelligence usage.

**Response:**
```json
{
  "web_search_requests": {
    "used": 12,
    "limit": 50,
    "reset_at": "2026-04-08T00:00:00.000Z"
  },
  "web_crawl_pages": {
    "used": 45,
    "limit": 100,
    "reset_at": "2026-04-08T00:00:00.000Z"
  }
}
```

---

### GET /api/web/usage/monthly

Get monthly usage accounting.

**Response:**
```json
{
  "web_search_requests": {
    "used": 234,
    "limit": 3000
  },
  "web_crawl_pages": {
    "used": 1250,
    "limit": 15000
  },
  "month": "2026-04",
  "reset_at": "2026-05-01T00:00:00.000Z"
}
```

---

### GET /api/admin/metrics

Admin metrics for web intelligence (requires `admin:*` scope).

**Response:**
```json
{
  "webIntelligence": {
    "tavily": {
      "successes": 150,
      "failures": 3,
      "avg_response_time_ms": 1234,
      "credits_used": 180
    },
    "lightpanda": { ... },
    "fetch": { ... }
  }
}
```

---

## MCP Tools

Web Intelligence tools are exposed via MCP for AI agent integration.

### hivemind_web_search

**Scope:** `web_search` or `*`

**Description:** Search the web and return structured results. Returns async job receipt.

**Input Schema:**
```json
{
  "query": {
    "type": "string",
    "description": "Search query"
  },
  "domains": {
    "type": "array",
    "items": { "type": "string" },
    "description": "Optional domain allowlist"
  },
  "limit": {
    "type": "number",
    "description": "Max results (default: 10)"
  }
}
```

**Usage Example:**
```javascript
const result = await mcpClient.callTool('hivemind_web_search', {
  query: 'HIVEMIND artificial intelligence',
  limit: 5
});
// Returns: { job_id, status, type }
// Poll with hivemind_web_job_status
```

---

### hivemind_web_crawl

**Scope:** `web_crawl` or `*`

**Description:** Crawl web pages and extract content. Returns async job receipt.

**Input Schema:**
```json
{
  "urls": {
    "type": "array",
    "items": { "type": "string" },
    "description": "Seed URLs to crawl"
  },
  "depth": {
    "type": "number",
    "description": "Crawl depth (default: 1, max: 3)"
  },
  "page_limit": {
    "type": "number",
    "description": "Max pages (default: 10, max: 50)"
  }
}
```

**Usage Example:**
```javascript
const result = await mcpClient.callTool('hivemind_web_crawl', {
  urls: ['https://example.com/docs'],
  depth: 1,
  page_limit: 10
});
```

---

### hivemind_web_job_status

**Scope:** `web_search`, `web_crawl`, or `*`

**Description:** Check status of a web search or crawl job.

**Input Schema:**
```json
{
  "job_id": {
    "type": "string",
    "description": "Job ID from search/crawl submission"
  }
}
```

**Usage Example:**
```javascript
const status = await mcpClient.callTool('hivemind_web_job_status', {
  job_id: '495659a3-eb4e-4506-beeb-063c4e694d44'
});
// Poll until status === 'succeeded'
```

---

### hivemind_web_usage

**Scope:** `web_search`, `web_crawl`, or `*`

**Description:** Check web intelligence quota and usage.

**Usage Example:**
```javascript
const usage = await mcpClient.callTool('hivemind_web_usage');
// Check remaining quota before submitting jobs
```

---

## Frontend Integration

### React Component

The Web Intelligence UI is available at `frontend/Da-vinci/src/components/hivemind/app/pages/WebIntelligence.jsx`.

**Key Features:**
- Search and crawl forms with validation
- Real-time job polling with SSE/WebSocket
- Result display with relevance scores, favicons
- Save-to-memory integration
- Usage quota visualization
- Runtime/fallback badges
- Error handling with retry

**Usage:**
```jsx
import WebIntelligence from './pages/WebIntelligence';

// In your app router
<Route path="/hivemind/app/web-intelligence" element={WebIntelligence} />
```

### API Client Methods

```javascript
// frontend/Da-vinci/src/components/hivemind/app/shared/api-client.js

// Submit search
await apiClient.submitWebSearch({ query, domains, limit });

// Submit crawl
await apiClient.submitWebCrawl({ urls, depth, pageLimit });

// Poll job
await apiClient.getWebJob(jobId);

// Retry failed job
await apiClient.retryWebJob(jobId);

// Save to memory
await apiClient.saveWebResultToMemory(jobId, { resultIndex, title, tags });
```

---

## Safety & Policy Layer

### Domain Validation

All URLs are validated against:

1. **Internal/Private IP Blocks:**
   - `localhost`, `127.x.x.x`, `10.x.x.x`, `192.168.x.x`, `172.16-31.x.x`
   - IPv6: `::1`, `fe80:`, `fd00:` (ULA)

2. **Blocked Domains:**
   - Adult content: `pornhub.com`, `xvideos.com`, `xnxx.com`, etc.
   - Malware/phishing: Known malicious domains
   - Illegal marketplaces: Silk Road, AlphaBay variants

3. **User Overrides:**
   - `allowlist`: Bypass default blocks
   - `denylist`: Additional user-specified blocks

**Function:** `validateDomain(url, userPolicy)`

```javascript
import { validateDomain } from './web/web-policy.js';

const result = validateDomain('https://example.com', {
  allowlist: ['trusted.com'],
  denylist: ['untrusted.com']
});
// { allowed: true } or { allowed: false, reason: '...' }
```

---

### Content Filtering

Strips dangerous content from crawled pages:

- Script tags
- Inline event handlers (`onclick=`, etc.)
- Iframes, objects, embeds
- Data URIs (HTML/JS)
- `javascript:` and `vbscript:` URIs

**Function:** `filterContent(text, options)`

```javascript
import { filterContent } from './web/web-policy.js';

const { text, filtered_count } = filterContent(rawHtml, {
  maxBytes: 500 * 1024  // 500KB limit
});
```

---

### Restricted Domain Advisories

Warns (but doesn't block) for domains with strict ToS:

- `twitter.com` / `x.com` - Use Twitter API instead
- `facebook.com`, `instagram.com` - ToS restrictions
- `linkedin.com` - Aggressive anti-scraping
- `tiktok.com`, `reddit.com`, `pinterest.com`, `amazon.com`

---

## Rate Limits & Quotas

### Default Limits

| Limit Type | Default | Env Variable |
|------------|---------|--------------|
| Search requests/day | 50 | `HIVEMIND_WEB_SEARCH_DAILY_LIMIT` |
| Crawl pages/day | 100 | `HIVEMIND_WEB_CRAWL_DAILY_LIMIT` |
| Search requests/month | 3000 | `HIVEMIND_WEB_SEARCH_MONTHLY_LIMIT` |
| Crawl pages/month | 15000 | `HIVEMIND_WEB_CRAWL_MONTHLY_LIMIT` |
| Requests/minute (user) | 10 | Built into `UserRateLimiter` |
| Requests/hour (user) | 60 | Built into `UserRateLimiter` |

### Rate Limiter

Sliding window implementation per user ID:

```javascript
import { UserRateLimiter } from './web/web-policy.js';

const limiter = new UserRateLimiter({
  maxPerMinute: 10,
  maxPerHour: 60
});

const check = limiter.check(userId);
// { allowed: true } or { allowed: false, retryAfterMs: 12345 }
```

### Abuse Detection

Detects and blocks abusive patterns:

- High-frequency identical queries
- Mass URL submission
- Repeated blocked domain attempts

**Function:** `detectAbuse({ userId, type, query, recentJobCount })`

```javascript
import { detectAbuse } from './web/web-policy.js';

const abuseCheck = detectAbuse({
  userId: 'user-123',
  type: 'search',
  query: 'repeated query',
  recentJobCount: 50
});

if (abuseCheck.action === 'block') {
  // Reject request
}
```

---

## Telemetry & Monitoring

### Tavily Telemetry

Tracked automatically for all Tavily operations:

```javascript
// core/src/web/tavily-client.js
const telemetry = {
  totalRequests: 0,
  searchRequests: 0,
  extractRequests: 0,
  crawlRequests: 0,
  mapRequests: 0,
  successes: 0,
  failures: 0,
  creditsUsed: 0,
  avgResponseTimeMs: 0
};

// Access via
const client = getTavilyClient();
const stats = client.getTelemetry();
```

### Runtime Telemetry

```javascript
// core/src/web/browser-runtime.js
const { getTelemetry } = await import('./web/browser-runtime.js');

const telemetry = getTelemetry();
// {
//   tavily: { successes, failures, avg_response_time_ms, credits_used },
//   lightpanda: { ... },
//   fetch: { ... },
//   circuitBreakerTrips: 0
// }
```

### Admin Metrics Endpoint

```bash
curl http://localhost:3001/api/admin/metrics \
  -H "Authorization: Bearer $MASTER_KEY"
```

---

## Error Handling

### Error Response Format

```json
{
  "error": "Error message",
  "code": "error_code",
  "details": { ... }
}
```

### Common Error Codes

| Code | HTTP Status | Meaning |
|------|-------------|---------|
| `quota_exceeded` | 429 | Daily/monthly limit reached |
| `rate_limited` | 429 | Per-minute/hour limit |
| `feature_not_enabled` | 403 | Plan doesn't include web intel |
| `abuse_detected` | 403 | Abuse pattern detected |
| `domain_blocked` | 403 | URL on blocklist |
| `invalid_url` | 400 | Malformed URL |
| `job_not_found` | 404 | Job ID doesn't exist |

### Tavily-Specific Errors

```javascript
// Wrapped errors include metadata
const wrapped = new Error(`Tavily ${operation} failed: ${errorMessage}`);
wrapped.originalError = error;
wrapped.statusCode = statusCode;
wrapped.isRateLimit = statusCode === 429;
wrapped.isAuthError = statusCode === 401;
wrapped.isQuotaExceeded = statusCode === 432 || statusCode === 433;
```

### Circuit Breaker

Automatically opens after 5 consecutive failures:

```
CLOSED → OPEN (after 5 failures) → HALF_OPEN (after 60s) → CLOSED (on success)
```

---

## Configuration

### Environment Variables

```bash
# Tavily API (required for primary runtime)
TAVILY_API_KEY=tvly-dev-...

# Rate limits
HIVEMIND_WEB_SEARCH_DAILY_LIMIT=50
HIVEMIND_WEB_CRAWL_DAILY_LIMIT=100
HIVEMIND_WEB_SEARCH_MONTHLY_LIMIT=3000
HIVEMIND_WEB_CRAWL_MONTHLY_LIMIT=15000

# Job timeout
HIVEMIND_WEB_JOB_TIMEOUT_MS=120000

# API key requirement (set to 'false' for local dev)
HIVEMIND_API_KEY_REQUIRED=false

# Test API key (non-production only)
HIVEMIND_TEST_API_KEY=test-key-12345

# Master API key (all environments)
HIVEMIND_MASTER_API_KEY=hmk_live_...
```

### User Policy Overrides

```javascript
// Per-user allowlist/denylist
const userPolicy = {
  allowlist: ['blocked-but-needed.com'],
  denylist: ['allowed-but-unwanted.com']
};
```

---

## Deep Research Integration

The Deep Research engine automatically uses Web Intelligence for web searches during research sessions.

### Integration Point

```javascript
// core/src/deep-research/researcher.js
async _webSearch(query) {
  if (this.browserRuntime) {
    const result = await this.browserRuntime.search({ query, limit: 5 });
    return result.results;
  }
  // Fallback: DuckDuckGo
}

async _followUpRead(url) {
  if (this.browserRuntime) {
    const result = await this.browserRuntime.crawl({ urls: [url] });
    return result.pages[0]?.content;
  }
  // Fallback: direct fetch
}
```

### Instantiation

```javascript
// core/src/server.js
const researcher = new DeepResearcher({
  memoryStore: persistentMemoryStore,
  recallFn: recallPersistedMemories,
  prisma,
  groqApiKey: process.env.GROQ_API_KEY,
  browserRuntime,  // Injected with Tavily chain
  webJobStore,
  onEvent: (event) => { session.events.push(event); },
  trailStore,
});
```

### Events Emitted

- `web.searching` - Starting web search
- `web.results` - Search results received
- `web.reading` - Crawling URL
- `web.read_complete` - Crawl completed
- `web.error` - Search/crawl failed

---

## Testing

### Test Scripts

```bash
# Basic Tavily test
node test-tavily.js

# Runtime comparison
node test-web-runtimes-compare.js
```

### Manual Testing with curl

```bash
# Submit search
curl -X POST http://localhost:3001/api/web/search/jobs \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"query": "test query", "limit": 3}'

# Check job status
curl http://localhost:3001/api/web/jobs/$JOB_ID \
  -H "Authorization: Bearer $API_KEY"
```

---

## Contributing

### Adding New Runtimes

1. Create runtime class in `core/src/web/`
2. Implement `search()` and `crawl()` methods
3. Add to fallback chain in `BrowserRuntime`
4. Update telemetry tracking

### Adding New MCP Tools

1. Add tool definition in `generateToolsManifest()` (hosted-service.js)
2. Add handler in `handleToolCall()` switch statement
3. Update scope gating if needed
4. Document in this file

---

## Changelog

### v2.0 (2026-04-07)
- Added Tavily API as primary runtime
- Enhanced LightPanda with multi-engine search
- Enhanced Fetch with metadata extraction
- Improved domain filtering and content policy
- Added runtime telemetry

### v1.0 (Initial)
- Basic LightPanda browser automation
- DuckDuckGo fallback
- Async job architecture
- Frontend Web Intelligence UI

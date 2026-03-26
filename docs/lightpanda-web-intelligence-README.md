# Lightpanda + HIVEMIND Web Intelligence (README)

## Overview
This document defines how HIVEMIND integrates Lightpanda for Web Intelligence, how Web Intelligence is exposed through REST and MCP, and how entitlements/safety/reliability controls work in production.

Web Intelligence supports:
- Async web search jobs
- Async web crawl jobs
- Save web results into HIVEMIND memory
- Quota/limit reporting
- Policy checks
- Admin telemetry

Implementation roots:
- Backend runtime and policy: `core/src/web/*`
- API routes: `core/src/server.js`
- MCP hosted tools: `core/src/mcp/hosted-service.js`
- Scope model: `core/src/auth/api-keys.js`
- Frontend Web UI: `frontend/Da-vinci/src/components/hivemind/app/pages/WebIntelligence.jsx`

---

## Architecture
### Request flow
1. Client submits `search` or `crawl` request to Core API.
2. Core validates entitlement, rate limits, abuse checks, and quota limits.
3. Core creates an async web job (`queued`) in `web-job-store`.
4. Core executes runtime:
- Primary: Lightpanda (CDP)
- Fallback: fetch runtime
5. Core stores status/results/errors in job record.
6. Client polls job status.
7. Optional: client calls `save-to-memory` to persist results in HIVEMIND memory graph.

### Runtime strategy
`core/src/web/browser-runtime.js` includes:
- Per-domain concurrency cap (`DomainConcurrencyTracker`)
- Circuit breaker (`CircuitBreaker`)
- Per-job timeout (`HIVEMIND_WEB_JOB_TIMEOUT_MS`)
- Error classification
- Fallback telemetry (`getTelemetry()`)

Primary runtime modes:
- Local Lightpanda binary (`@lightpanda/browser` + `playwright-core`)
- Lightpanda Cloud CDP websocket (if configured)

Fallback mode:
- Direct HTTP fetch extraction when primary path fails

---

## Entitlements and Access Model
Defined in `core/src/auth/api-keys.js`:
- `memory:read`
- `memory:write`
- `mcp`
- `web_search`
- `web_crawl`
- `web_admin`

Rules:
- `web_search` required for search submit.
- `web_crawl` required for crawl submit.
- Either `web_search` or `web_crawl` required for web limits endpoint.
- `web_admin` required for admin metrics endpoint.
- `*` scope bypasses entitlement checks.

Recommended key presets:
- Standard agent: `memory:read`, `memory:write`, `mcp`
- Web Intelligence agent: above + `web_search`, `web_crawl`
- Web admin/operator: above + `web_admin`

---

## REST API Contract (Core)
Base: `https://core.hivemind.davinciai.eu:8050`
Auth: `X-API-Key: <key>`

### Submit search job
`POST /api/web/search/jobs`

Body:
```json
{
  "query": "groq pricing",
  "domains": ["groq.com"],
  "limit": 10
}
```

Response:
- `202` queued with `job_id`
- `403` `feature_not_enabled` if missing `web_search`
- `429` `rate_limited` / `quota_exceeded` / `monthly_quota_exceeded`

### Submit crawl job
`POST /api/web/crawl/jobs`

Body:
```json
{
  "urls": ["https://groq.com/pricing"],
  "depth": 1,
  "page_limit": 10
}
```

Response:
- `202` queued with `job_id`
- `403` `feature_not_enabled` if missing `web_crawl`
- `429` quota/limit errors

### List jobs
`GET /api/web/jobs?limit=30&type=search|crawl`

### Job status
`GET /api/web/jobs/:jobId`

### Retry failed job
`POST /api/web/jobs/:jobId/retry`

### Save job result(s) to memory
`POST /api/web/jobs/:jobId/save-to-memory`

Body:
```json
{
  "resultIndex": 0,
  "title": "Optional custom title",
  "tags": ["web-search"]
}
```

Behavior:
- Without `resultIndex`, saves all results from job.
- Persists using `persistentMemoryEngine.ingestMemory(...)`.
- Memory type is valid enum (`fact`).
- Returns:
```json
{
  "saved": 10,
  "memory_ids": ["..."]
}
```

### Daily usage
`GET /api/web/usage`

### Monthly usage
`GET /api/web/usage/monthly`

### Export usage
`GET /api/web/usage/export?from=YYYY-MM-DD&to=YYYY-MM-DD`

### Limits snapshot
`GET /api/web/limits`

### Domain policy advisory
`POST /api/web/policy/check-domain`

Body:
```json
{ "url": "https://example.com" }
```

### Admin metrics (restricted)
`GET /api/web/admin/metrics`
- Requires `web_admin` (or `*`)
- Org-scoped admin sees own org
- Global admin sees all orgs

---

## Error Model
Common API error codes:
- `feature_not_enabled`
- `insufficient_scope`
- `rate_limited`
- `quota_exceeded`
- `monthly_quota_exceeded`
- `abuse_detected`

Runtime error classifications:
- `navigation_failed`
- `timeout`
- `blocked_site`
- `concurrency_limit`
- `circuit_open`
- `job_timeout`

Web jobs with zero usable output and classified errors are marked `failed` (not false success).

---

## Safety & Policy Layer
`core/src/web/web-policy.js`

Includes:
- Domain block/allow logic
- Internal/private address blocking (SSRF hardening)
- Content filtering:
  - strips scripts/iframes/dangerous URI forms
  - output cap (`500KB` default)
- Per-user sliding-window rate limiter:
  - 10/min
  - 60/hr
- Abuse detection:
  - rapid-fire patterns
  - suspicious query shape/length
  - deep/unsafe behavior heuristics
- Robots/ToS advisory warnings for known restricted domains

---

## Reliability Controls
`core/src/web/browser-runtime.js`

Implemented:
- Domain concurrency cap (3 active per domain)
- Circuit breaker:
  - opens after repeated failures
  - half-open probe window
  - auto-close on healthy probe
- Per-job timeout (default 2 min)
- Runtime fallback (Lightpanda -> fetch)
- Structured telemetry for runtime/fallback/error distribution

---

## MCP Tools Integration
`core/src/mcp/hosted-service.js`

Web tools exposed (scope-gated in tools list):
- `hivemind_web_search`
- `hivemind_web_crawl`
- `hivemind_web_job_status`
- `hivemind_web_usage`

Visibility rules:
- `hivemind_web_search` only with `web_search` or `*`
- `hivemind_web_crawl` only with `web_crawl` or `*`
- `job_status`/`usage` shown when any web scope exists

Execution:
- Tool calls proxy to Core `/api/web/*` routes
- Route entitlement checks remain enforced defense-in-depth

---

## Frontend Integration
Primary page: `WebIntelligence.jsx`

Capabilities:
- Locked/unlocked UX based on entitlement
- Daily and monthly quota cards
- Domain policy check on URL blur
- Live polling every 2s for active jobs
- Retry action for failed jobs
- Save-to-memory action for single or all results
- Error type labels and runtime badges

Admin page:
- `WebAdmin.jsx`
- Uses `/api/web/admin/metrics`
- Sidebar item only appears when access probe succeeds

---

## Environment Variables
### Core web quotas
- `HIVEMIND_WEB_SEARCH_DAILY_LIMIT` (default `100`)
- `HIVEMIND_WEB_CRAWL_DAILY_LIMIT` (default `500`)
- `HIVEMIND_WEB_SEARCH_MONTHLY_LIMIT` (default `3000`)
- `HIVEMIND_WEB_CRAWL_MONTHLY_LIMIT` (default `15000`)

### Runtime timeout
- `HIVEMIND_WEB_JOB_TIMEOUT_MS` (default 120000)

### Lightpanda local mode
- `HIVEMIND_LIGHTPANDA_HOST` (default `127.0.0.1`)
- `HIVEMIND_LIGHTPANDA_PORT` (default `9222`)
- `LIGHTPANDA_EXECUTABLE_PATH` (optional explicit binary path)
- `XDG_CACHE_HOME` (optional cache path)

### Lightpanda cloud mode
- `HIVEMIND_LIGHTPANDA_CLOUD_WS` (full websocket endpoint), or
- `HIVEMIND_LIGHTPANDA_TOKEN` / `LPD_TOKEN`
- `HIVEMIND_LIGHTPANDA_REGION` (default `euwest`)

---

## Operations Runbook
### Verify route deployment
If frontend shows `404` for web routes, check backend deployment version mismatch first.

Quick checks:
```bash
curl -sk https://core.hivemind.davinciai.eu:8050/api/web/limits -H "X-API-Key: <key>"
curl -sk https://core.hivemind.davinciai.eu:8050/api/web/usage/monthly -H "X-API-Key: <key>"
```

### Verify save-to-memory
```bash
curl -sk -X POST \
  "https://core.hivemind.davinciai.eu:8050/api/web/jobs/<job-id>/save-to-memory" \
  -H "Content-Type: application/json" \
  -H "X-API-Key: <key>" \
  --data '{"tags":["web-search"]}'
```

### Restart services
```bash
docker restart hm-core hm-control
```

---

## Troubleshooting
### 403 on search/crawl
Cause: missing `web_search` / `web_crawl` scope.
Fix: create or rotate API key with required scopes.

### 404 on web endpoints
Cause: old backend container image/code running.
Fix: deploy/restart current core service.

### Save-to-memory fails
Check:
- job exists and succeeded
- persistent memory engine is available
- schema enum values are valid

### Browser console `Access to storage is not allowed from this context`
Usually browser/extension sandbox/privacy context issue.
Does not necessarily indicate backend failure.

---

## Cost and Licensing Notes
- Current HIVEMIND path is self-hosted Lightpanda runtime in core container.
- No per-request Lightpanda Cloud billing in this self-hosted mode.
- Infrastructure costs still apply (compute/network/storage).
- Lightpanda open-source licensing obligations still apply; review upstream terms for compliance.

---

## Test Coverage Snapshot
Web suite currently includes:
- `core/tests/web/web-policy.test.js`
- `core/tests/web/web-job-store.test.js`
- `core/tests/web/browser-runtime.test.js`
- `core/tests/web/mcp-tools-visibility.test.js`
- `core/tests/web/admin-auth.test.js`

Expected run:
```bash
npx vitest run core/tests/web
```

---

## Changelog Notes (Integration Milestones)
- Lightpanda CDP integration wired into runtime
- Safety/policy layer added
- Reliability controls (concurrency, circuit breaker, timeout) added
- Web save-to-memory endpoint stabilized
- MCP web tools added + visibility gating by scope
- Admin metrics auth tightened with `web_admin`


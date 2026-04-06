# Comprehensive Usage Tracking Implementation

## Summary

Implemented comprehensive usage tracking throughout the HIVEMIND platform for tokens, memories, connections, searches, deep research, web intel, KB uploads, and graph queries - enforcing plan limits (Free, Pro, Scale, Enterprise).

## Database Changes

### OrgUsage Table Schema Updates

**File:** `/opt/HIVEMIND/core/prisma/migrations/manual/add_org_usage_extended_fields.sql`

Added columns to track:
- `memoriesIngested` - Count of memories created this month
- `deepResearchJobs` - Count of deep research sessions this month
- `webIntelJobs` - Count of web intel jobs (daily tracking)
- `webIntelDay` - Date field for daily web intel reset
- `connectorCount` - Count of active connectors
- `graphQueries` - Count of graph queries this month
- `taraUsage` - Count of TARA voice agent sessions

**Migration:** Run `add_org_usage_extended_fields.sql` on production database.

## Backend Changes

### 1. UsageTracker (`core/src/billing/usage-tracker.js`)

**New methods:**
- `recordMemory(orgId)` - Track memory ingestion
- `recordDeepResearch(orgId)` - Track deep research sessions
- `recordWebIntel(orgId)` - Track web intel jobs (daily reset)
- `recordGraphQuery(orgId)` - Track graph queries
- `recordTara(orgId)` - Track TARA usage
- `getWebIntelToday(orgId)` - Get today's web intel count

**Updated methods:**
- `getUsage(orgId)` - Returns all new fields
- `checkLimits(orgId, planId)` - Checks all limits including daily web intel
- `_emptyUsage()` - Returns all fields initialized to 0

### 2. PlanEnforcer (`core/src/billing/plan-enforcer.js`)

**Updated `_getCounters()`:**
- Seeds all new counters from UsageTracker

**Updated `checkLimit()`:**
- Added `memories` check (maxMemories limit)
- Added `deepResearch` check (deepResearchPerMonth limit)
- Added `webIntel` check (webIntelPerDay limit with daily reset)
- Added `graphQueries` check (searchQueriesPerMonth limit)
- Added `tara` check (tracked but not limited)

**Updated `recordUsage()`:**
- Records all new usage types to UsageTracker

**Updated `getUsageSummary()`:**
- Returns all metrics for frontend display

### 3. Server Endpoint Enforcement (`core/src/server.js`)

#### Memory Ingestion (`POST /api/memories`)
- Check: `planEnforcer.checkLimit(orgId, 'memories', 1)` before ingest
- Record: `planEnforcer.recordUsage(orgId, 'memories', count)` after success
- Location: Lines ~4850-4870, ~5021-5030, ~5099-5108

#### Deep Research (`POST /api/research/start`)
- Check: `planEnforcer.checkLimit(orgId, 'deepResearch', 1)` before start
- Record: `planEnforcer.recordUsage(orgId, 'deepResearch', 1)` on completion
- Location: Lines ~3061-3115

#### Web Intel (`POST /api/web/search/jobs`, `POST /api/web/crawl/jobs`)
- Check: `planEnforcer.checkLimit(orgId, 'webIntel', 1)` before job creation
- Record: `planEnforcer.recordUsage(orgId, 'webIntel', 1)` on job success
- Location: Lines ~3967-4040, ~4053-4230

#### Connector Creation (Gmail OAuth callback)
- Check: `planEnforcer.checkLimit(orgId, 'connectors', 1)` before upsert
- Note: Connector count is dynamic (DB query), not stored in counter
- Location: Lines ~2269-2282

#### Graph Queries (`GET /api/graph`)
- Record: `planEnforcer.recordUsage(orgId, 'graphQueries', 1)` on response
- Location: Lines ~6372-6378

## Frontend Changes

### Billing Page (`frontend/Da-vinci/src/components/hivemind/app/pages/Billing.jsx`)

**New usage API call:**
```js
const { data: usage } = useApiQuery(
  () => apiClient.core.get('/api/billing/usage').catch(() => null),
  [],
);
```

**Updated metrics displayed:**
- Tokens This Month (limit: llmTokensPerMonth)
- Memories (limit: maxMemories)
- Deep Research (limit: deepResearchPerMonth)
- Web Intel Daily (limit: webIntelPerDay)
- Searches This Month (limit: searchQueriesPerMonth)
- KB Uploads (limit: knowledgeBaseUploadsPerMonth)
- Graph Queries (limit: searchQueriesPerMonth)
- Connections (limit: maxConnectors)

**Plan definitions updated** with all limit fields matching backend plans.js

## Plan Limits Reference

| Limit | Free | Pro | Scale | Enterprise |
|-------|------|-----|-------|------------|
| maxMemories | 1,000 | 25,000 | 250,000 | Unlimited (-1) |
| llmTokensPerMonth | 1M | 10M | 100M | Unlimited (-1) |
| deepResearchPerMonth | 3 | 20 | Unlimited (-1) | Unlimited (-1) |
| webIntelPerDay | 5 | 50 | 500 | Unlimited (-1) |
| searchQueriesPerMonth | 10K | 100K | 2M | Unlimited (-1) |
| maxConnectors | 3 | 10 | Unlimited (-1) | Unlimited (-1) |
| knowledgeBaseUploadsPerMonth | 10 | Unlimited (-1) | Unlimited (-1) | Unlimited (-1) |
| maxUsers | 1 | 5 | 25 | Unlimited (-1) |

## Error Responses

When limits are exceeded, endpoints return:

```json
{
  "error": "Plan limit exceeded",
  "message": "Memory limit exceeded (Free plan: 1,000 memories)",
  "limit": 1000,
  "current": 1000,
  "plan": "free"
}
```

HTTP Status: **403 Forbidden**

## Testing Checklist

- [ ] Run database migration on dev environment
- [ ] Test memory creation hits limit at 1,000 (Free plan)
- [ ] Test deep research hits limit at 3 sessions (Free plan)
- [ ] Test web intel hits limit at 5 jobs/day (Free plan)
- [ ] Test connector creation hits limit at 3 (Free plan)
- [ ] Test graph queries are tracked
- [ ] Test Billing page shows all metrics correctly
- [ ] Test plan upgrade resets counters
- [ ] Test daily web intel reset at midnight

## Files Modified

1. `core/prisma/migrations/manual/create_org_usage.sql` - Updated schema
2. `core/prisma/migrations/manual/add_org_usage_extended_fields.sql` - New migration
3. `core/src/billing/usage-tracker.js` - Added tracking methods
4. `core/src/billing/plan-enforcer.js` - Added limit checks and recording
5. `core/src/server.js` - Added enforcement at endpoints
6. `frontend/Da-vinci/src/components/hivemind/app/pages/Billing.jsx` - Updated UI

## Deployment Steps

1. Run database migration:
   ```sql
   \i /opt/HIVEMIND/core/prisma/migrations/manual/add_org_usage_extended_fields.sql
   ```

2. Restart backend server to load new UsageTracker and PlanEnforcer code

3. Deploy frontend (Vercel auto-deploys on push)

4. Monitor logs for enforcement:
   ```bash
   grep "Plan limit exceeded" core/logs/app.log
   ```

## Notes

- Web intel uses daily reset (tracked by `webIntelDay` column)
- Connector count is queried dynamically from PlatformIntegration table
- TARA usage is tracked but not limited (uses token budget)
- Over 80% usage shows warning (amber meter)
- 100% usage blocks further operations (unless on overage plan)

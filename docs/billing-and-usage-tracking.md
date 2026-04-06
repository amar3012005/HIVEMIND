# Billing and Usage Tracking

**Last Updated:** 2026-04-06  
**Version:** 2.0  
**Status:** Production

## Overview

HIVEMIND implements a comprehensive usage tracking and billing system that monitors resource consumption across all platform features. The system enforces plan-based limits while providing real-time visibility into usage through the Billing dashboard.

### Key Features

- **Real-time tracking** of all API operations
- **Plan-based enforcement** with automatic limit checks
- **Daily and monthly limits** with automatic resets
- **Usage dashboard** showing current consumption
- **Graceful degradation** with warnings at 80% usage

---

## Subscription Plans

HIVEMIND offers four subscription tiers with increasing resource allocations:

| Feature | Free | Pro (€19/mo) | Scale (€199/mo) | Enterprise |
|---------|------|--------------|-----------------|------------|
| **Memories** | 1,000 | 25,000 | 250,000 | Unlimited |
| **LLM Tokens/Month** | 1M | 10M | 100M | Unlimited |
| **Deep Research/Month** | 3 | 20 | Unlimited | Unlimited |
| **Web Intel/Day** | 5 | 50 | 500 | Unlimited |
| **Search Queries/Month** | 10K | 100K | 2M | Unlimited |
| **Connectors** | 3 | 10 | Unlimited | Unlimited |
| **KB Uploads/Month** | 10 | Unlimited | Unlimited | Unlimited |
| **Users** | 1 | 5 | 25 | Unlimited |
| **Support** | Community | Email (48h) | Priority (24h) | Dedicated CSM |
| **SLA** | None | 99.5% | 99.9% | Custom |

### Plan Gated Features

All plans include core features:
- Memory Graph visualization
- MCP Protocol support
- Agent Swarm (CSI)
- Web Intelligence
- Deep Research
- Talk to HIVE
- TARA Voice Agent
- LLM Observer

Scale+ adds:
- SSO/SAML authentication
- Webhooks
- Audit Logs
- Team Workspaces
- DPA Compliance

Enterprise adds:
- HYOK Encryption
- Dedicated Infrastructure
- Custom SLA

---

## Architecture

### Components

```
┌─────────────────────────────────────────────────────────────────┐
│                     API Endpoint Layer                          │
│  (server.js - checks PlanEnforcer before processing requests)   │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      PlanEnforcer                               │
│  - In-memory counters (hot path)                                │
│  - checkLimit(type, amount) → { allowed, reason, limit, current }│
│  - recordUsage(type, amount) → fire-and-forget to DB            │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                      UsageTracker                               │
│  - recordTokens(), recordQuery(), recordMemory(), etc.          │
│  - 60s cache for getUsage()                                     │
│  - Direct SQL: INSERT ... ON CONFLICT DO UPDATE                 │
└─────────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────────┐
│                    PostgreSQL: OrgUsage                         │
│  - orgId, month, tokensProcessed, searchQueries, etc.           │
│  - Unique constraint: (orgId, month)                            │
│  - Daily tracking: webIntelDay column                           │
└─────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Request arrives** at API endpoint (e.g., `POST /api/memories`)
2. **PlanEnforcer.checkLimit()** verifies org hasn't exceeded limit
3. **If allowed**: Request processed, response sent
4. **recordUsage()** updates in-memory counter immediately
5. **UsageTracker** persists to database asynchronously (fire-and-forget)
6. **Frontend polls** `/api/billing/usage` for real-time dashboard

---

## Database Schema

### OrgUsage Table

```sql
CREATE TABLE "OrgUsage" (
  "id" UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  "orgId" UUID NOT NULL,
  "month" VARCHAR(7) NOT NULL,      -- YYYY-MM format
  "tokensProcessed" BIGINT NOT NULL DEFAULT 0,
  "searchQueries" BIGINT NOT NULL DEFAULT 0,
  "knowledgeBaseUploads" INTEGER NOT NULL DEFAULT 0,
  "memoriesIngested" INTEGER NOT NULL DEFAULT 0,
  "deepResearchJobs" INTEGER NOT NULL DEFAULT 0,
  "webIntelJobs" INTEGER NOT NULL DEFAULT 0,
  "webIntelDay" DATE NOT NULL DEFAULT CURRENT_DATE,  -- For daily reset
  "connectorCount" INTEGER NOT NULL DEFAULT 0,
  "graphQueries" BIGINT NOT NULL DEFAULT 0,
  "taraUsage" INTEGER NOT NULL DEFAULT 0,
  "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE ("orgId", "month")
);

CREATE INDEX "idx_org_usage_org_month" ON "OrgUsage" ("orgId", "month");
CREATE INDEX "idx_org_usage_org_day" ON "OrgUsage" ("orgId", "webIntelDay");
```

### Migration

Run on production database:

```bash
psql -d hivemind -f core/prisma/migrations/manual/add_org_usage_extended_fields.sql
```

---

## API Reference

### Check Usage

```http
GET /api/billing/usage
Authorization: Bearer <api_key>
```

**Response:**

```json
{
  "plan": "pro",
  "planName": "Pro",
  "period": { "month": "2026-04" },
  "tokens": { "used": 1250000, "limit": 10000000 },
  "searches": { "used": 5420, "limit": 100000 },
  "uploads": { "used": 3, "limit": -1 },
  "memories": { "used": 8500, "limit": 25000 },
  "deepResearch": { "used": 12, "limit": 20 },
  "webIntel": { "used": 35, "limit": 50, "isDaily": true },
  "graphQueries": { "used": 2100, "limit": 100000 },
  "tara": { "used": 45, "limit": -1 },
  "connectors": { "limit": 10 },
  "users": { "limit": 5 }
}
```

**Notes:**
- `limit: -1` indicates unlimited
- `isDaily: true` indicates the counter resets daily
- `connectors` count is queried dynamically from `PlatformIntegration` table

### Upgrade Plan

```http
POST /api/billing/upgrade
Authorization: Bearer <api_key>
Content-Type: application/json

{
  "plan": "scale"
}
```

**Response:**

```json
{
  "success": true,
  "plan": "scale",
  "effectiveDate": "2026-04-06T14:32:00Z"
}
```

---

## Enforcement Points

### Memory Ingestion

**Endpoint:** `POST /api/memories`

**Check:** Before ingest
```js
const memoryLimitCheck = await planEnforcer.checkLimit(orgId, 'memories', 1);
if (!memoryLimitCheck.allowed) {
  return jsonResponse(res, {
    error: 'Plan limit exceeded',
    message: memoryLimitCheck.reason,
    limit: memoryLimitCheck.limit,
    current: memoryLimitCheck.current,
    plan: memoryLimitCheck.plan
  }, 403);
}
```

**Record:** After successful ingest
```js
planEnforcer.recordUsage(orgId, 'memories', ingestPayloads.filter(p => !p.skipped).length);
```

### Deep Research

**Endpoint:** `POST /api/research/start`

**Check:** Before starting research session
**Record:** On completion (in `.then()` block)

### Web Intelligence

**Endpoints:** `POST /api/web/search/jobs`, `POST /api/web/crawl/jobs`

**Check:** Before job creation (daily limit)
**Record:** On job success

**Note:** Web intel uses daily reset via `webIntelDay` column:
```sql
INSERT INTO "OrgUsage" (...) VALUES (...)
ON CONFLICT ("orgId", "webIntelDay")
DO UPDATE SET "webIntelJobs" = "OrgUsage"."webIntelJobs" + 1
```

### Connector Creation

**Endpoint:** Gmail OAuth callback (`/api/connectors/gmail/callback`)

**Check:** Before upsert
**Note:** Connector count queried dynamically from `PlatformIntegration` table

### Graph Queries

**Endpoint:** `GET /api/graph`

**Record:** On response (no hard limit, tracked for analytics)

---

## Error Responses

### Limit Exceeded (403)

```json
{
  "error": "Plan limit exceeded",
  "message": "Memory limit exceeded (Free plan: 1,000 memories)",
  "limit": 1000,
  "current": 1000,
  "plan": "free"
}
```

### Rate Limit (429)

```json
{
  "error": "Rate limit exceeded",
  "code": "rate_limited",
  "retry_after_ms": 5000
}
```

---

## Frontend Integration

### React Hook Usage

```jsx
import apiClient from '../shared/api-client';

function BillingDashboard() {
  const { data: usage } = useApiQuery(
    () => apiClient.core.get('/api/billing/usage').catch(() => null),
    [],
  );

  const tokensUsed = usage?.tokens?.used ?? 0;
  const tokensLimit = usage?.tokens?.limit ?? -1;
  const isNearLimit = tokensLimit > 0 && (tokensUsed / tokensLimit) > 0.8;

  return (
    <UsageMeter
      label="Tokens This Month"
      used={tokensUsed}
      limit={tokensLimit}
      icon={Brain}
    />
  );
}
```

### UsageMeter Component

```jsx
function UsageMeter({ label, used, limit, icon: Icon }) {
  const isUnlimited = !limit || limit === -1;
  const pct = isUnlimited ? 0 : Math.min((used / limit) * 100, 100);
  const isNearLimit = pct > 80;

  return (
    <div className="bg-white border border-[#e3e0db] rounded-xl p-4">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Icon size={14} className="text-[#a3a3a3]" />
          <span>{label}</span>
        </div>
        <span className="text-sm font-mono font-semibold">
          {used?.toLocaleString()} / {isUnlimited ? 'Unlimited' : limit?.toLocaleString()}
        </span>
      </div>
      <div className="w-full h-1.5 rounded-full bg-[#e3e0db] overflow-hidden">
        <div
          className={`h-full rounded-full ${
            isNearLimit ? 'bg-amber-400' : 'bg-[#117dff]'
          }`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {isNearLimit && (
        <p className="text-amber-400/70 text-[10px] mt-1.5">
          {pct >= 100 ? 'Limit reached — upgrade to continue' : 'Approaching limit'}
        </p>
      )}
    </div>
  );
}
```

---

## Operational Runbook

### Monitoring

**Check current usage:**
```bash
curl -H "Authorization: Bearer $API_KEY" https://api.hivemind.davinciai.eu/api/billing/usage | jq
```

**Check org plan:**
```sql
SELECT id, slug, plan FROM "Organization" WHERE id = '$ORG_ID';
```

**Check usage history:**
```sql
SELECT month, tokensProcessed, memoriesIngested, deepResearchJobs
FROM "OrgUsage"
WHERE "orgId" = '$ORG_ID'
ORDER BY month DESC
LIMIT 6;
```

### Manual Plan Change

```js
// In Node.js REPL or script
const { PlanStore } = await import('./src/billing/plan-store.js');
const planStore = new PlanStore(prisma);
await planStore.setOrgPlan(orgId, 'enterprise');
planStore.invalidate(orgId);
```

### Reset Usage Counter

**Warning:** Only for billing corrections

```sql
UPDATE "OrgUsage"
SET "tokensProcessed" = 0,
    "memoriesIngested" = 0,
    "updatedAt" = NOW()
WHERE "orgId" = '$ORG_ID' AND "month" = '2026-04';
```

### Debugging

**Check in-memory counter:**
```js
console.log(planEnforcer._counters.get(orgId));
```

**Check cache:**
```js
console.log(usageTracker._cache.get(`${orgId}:2026-04`));
```

**Force cache refresh:**
```js
usageTracker._invalidateCache(orgId);
```

---

## Best Practices

### For Developers

1. **Always check before processing** - Call `checkLimit()` before expensive operations
2. **Record after success** - Only call `recordUsage()` after successful completion
3. **Handle errors gracefully** - Show clear error messages with upgrade path
4. **Don't block on recording** - Use fire-and-forget for persistence
5. **Respect daily limits** - Web intel resets at midnight UTC

### For Users

1. **Monitor usage dashboard** - Check Billing page regularly
2. **Set up alerts** - Email notifications at 80% usage (future feature)
3. **Plan ahead** - Upgrade before hitting limits
4. **Understand daily vs monthly** - Web intel resets daily, everything else monthly

---

## Future Enhancements

- [ ] Email notifications at 80% usage
- [ ] Overage billing (pay for what you exceed)
- [ ] Usage alerts via webhooks
- [ ] Historical usage graphs
- [ ] Team member usage breakdown
- [ ] Cost allocation by project
- [ ] Reserved capacity pricing
- [ ] Auto-upgrade when limit reached

---

## Troubleshooting

### "Limit exceeded" but usage shows below limit

**Cause:** In-memory counter out of sync with database

**Fix:**
```js
// Force counter refresh
planEnforcer._counters.delete(orgId);
await planEnforcer._getCounters(orgId);
```

### Web intel limit not resetting at midnight

**Cause:** `webIntelDay` column uses server timezone

**Fix:** Ensure server timezone is UTC:
```bash
echo $TZ  # Should output: UTC
```

### Usage not appearing in dashboard

**Cause:** Frontend not fetching from `/api/billing/usage`

**Fix:** Check network tab for API call, verify auth token

---

## Related Documentation

- [API Reference](API_REFERENCE.md)
- [Connector Framework](connector-framework-v1-readme.md)
- [TARA Orchestrator API](tara-orchestrator-api.md)
- [Development Setup](development-setup.md)

---

## Changelog

### 2026-04-06 - v2.0
- Added comprehensive usage tracking for all metrics
- Implemented daily web intel limits with automatic reset
- Added graph query tracking
- Updated Billing dashboard with 8 usage meters
- Fixed plan limits to match backend plans.js

### 2026-03-01 - v1.0
- Initial implementation with token and search tracking
- Basic OrgUsage table schema
- Simple usage dashboard

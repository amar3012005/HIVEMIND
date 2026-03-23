# HIVEMIND — Future Scope Checklist

## Deferred Features

### Web Memory Intelligence
**Status:** Out of scope for Web Intelligence v1 launch.

**Scope when implemented:**
- Contradiction detection across web-sourced vs stored memories
- Source trust scoring (reliability, freshness, authority)
- Change timeline tracking (what changed between crawls)
- Entity-linking from web content into memory graph
- Automated web-to-memory ingestion pipeline (discover → validate → store)
- Temporal fact verification (was this true at time T?)

**Depends on:** Web Intelligence v1 (search + crawl jobs) being stable in production.

### Admin Observability Dashboard
**Status:** Deferred from productization sprint.

**Scope when implemented:**
- `/hivemind/app/admin` page with health cards for all subsystems
- Live log stream for core and control-plane
- Structured log ring buffer in server.js
- Auth-gated via X-Admin-Secret

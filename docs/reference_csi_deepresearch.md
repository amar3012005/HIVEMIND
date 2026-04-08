---
name: DeepResearch Schema & API Reference
description: Critical schema requirements, API endpoints, event types, and common pitfalls for DeepResearch feature
type: reference
---

# DeepResearch Schema Reference

## MemoryType Enum (CRITICAL)

**Valid values ONLY:**
- `fact` - Use for web sources (NOT 'source')
- `preference` - User preferences
- `decision` - Research trails
- `lesson` - Learned lessons
- `goal` - Goals
- `event` - Temporal events
- `relationship` - Relationships

**Common mistake:** Using 'source' - this is NOT valid and causes Prisma errors.

## UUID Generation Rules

**ALWAYS use plain randomUUID():**
```javascript
import { randomUUID } from 'node:crypto';
const id = randomUUID(); // ✅ Correct

// ❌ WRONG - causes UUID validation errors:
const id = `source-${randomUUID()}`;
```

## TrailStore Persistence Pattern

**Use UPSERT (create/update) not just create:**
```javascript
try {
  await createMemory({ id: trail.id, ... });
} catch (err) {
  if (err.code === 'P2002') { // Unique constraint
    await updateMemory(trail.id, { ... });
  }
}
```

## Complete Event Type List

**Frontend must handle ALL of these:**

1. `research.started` - {sessionId, query, projectId}
2. `web.searching` - {query}
3. `web.results` - {query, count, via}
4. `web.reading` - {url}
5. `web.read_complete` - {url, length, via}
6. `web.error` - {query, error}
7. `web` - {taskId, step, title}
8. `follow_up` - {taskId, step, title}
9. `task.reasoning` - {taskId, step, action, thought}
10. `task.observation` - {taskId, step, type, title}
11. `task.completed` - {taskId, findingCount, confidence}
12. `task.failed` - {taskId, error}
13. `research.reflecting` - {sessionId, round, confidence}
14. `research.synthesizing` - {sessionId, findingCount}
15. `research.completed` - {sessionId, findingCount, durationMs}
16. `research.blueprint_suggested` - {blueprintId, name, relevanceScore}
17. `research.blueprints_mined` - {count}
18. `research.cached` - {sessionId, findingCount}
19. `research.decomposed` - {sessionId, dimensions}

## API Endpoints

**Start Research:**
- POST `/api/research/start`
- Body: { query: string (5-1000 chars), forceRefresh?: boolean }
- Response: { session_id, project_id, status: "started" }

**Get Status:**
- GET `/api/research/:sessionId/status`
- Response: { status, query, progress, events[], error }

**Get Report:**
- GET `/api/research/:sessionId/report`
- Response: { report, findings[], sources[], gaps[], durationMs }

**Get Logs:**
- GET `/api/logs?container=hm-core|hm-control`
- Response: { container, logs[] }

## Research Session Flow

```
1. POST /api/research/start → returns session_id
2. Frontend polls GET /status every 2s
3. Events pushed to session.events array
4. When status === "completed":
   - GET /report for final results
   - Display report + findings
```

## Files to Check

**Backend:**
- `core/src/deep-research/researcher.js` - Main engine
- `core/src/deep-research/trail-store.js` - Persistence
- `core/src/server.js` - API routes (lines ~3117-3188)

**Frontend:**
- `frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx`
- EventCard component must handle all event types

## Common Errors & Fixes

1. **"Invalid memoryType"** → Use 'fact' not 'source'
2. **"Unique constraint failed on id"** → Use upsert pattern in TrailStore
3. **"Invalid UUID"** → Remove prefixes from randomUUID()
4. **Frontend shows no events** → Add missing event type handlers to EventCard

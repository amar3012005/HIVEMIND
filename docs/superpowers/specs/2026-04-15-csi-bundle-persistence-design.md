# CSI Bundle Persistence — Browser Cache + HIVEMIND Cloud

**Date:** 2026-04-15
**Scope:** MiroFish frontend (IndexedDB cache) + backend (bundle API) + HIVEMIND core (memory storage)

---

## Problem

Session data lives on the MiroFish Flask backend filesystem (`uploads/simulations/sim_xxx/`). This means:
- Sessions are lost if the server is wiped
- No cross-device access
- Sidebar reads from local filesystem, not cloud
- No persistence layer for returning users

## Solution

After report generation, compress all CSI artifacts into a single JSON bundle, push it to HIVEMIND as a tagged memory. Browser uses IndexedDB as a fast local cache. Sidebar fetches session list from HIVEMIND. Past sessions are "unveiled" by downloading the bundle and populating IndexedDB.

---

## 1. Data Flow

```
User completes research
        ↓
Backend bundles CSI artifacts (zlib + base64)
        ↓
POST /api/memories → HIVEMIND (tag: csi/bundle)
        ↓
Sidebar reads: GET /api/memories?tags=csi/bundle
        ↓
User clicks past session
        ↓
GET /api/memories/{id} → decompress → IndexedDB → render
```

## 2. Bundle Schema

One compressed memory per session:

```json
{
  "content": "<base64-zlib-compressed JSON>",
  "title": "CSI: What is the state of Strait of Hormuz",
  "memory_type": "decision",
  "tags": ["csi/bundle", "session:sim_xxx"],
  "metadata": {
    "bundle_type": "csi_research",
    "simulation_id": "sim_xxx",
    "compressed": true,
    "original_size": 48000,
    "claim_count": 14,
    "source_count": 38,
    "trial_count": 4,
    "agent_count": 8,
    "rounds_completed": 5,
    "report_id": "report_xxx",
    "created_at": "2026-04-15T19:45:00Z"
  }
}
```

**Decompressed bundle content:**
```json
{
  "simulation_id": "sim_xxx",
  "query": "What is the state of Strait of Hormuz",
  "timestamp": "2026-04-15T19:45:00Z",
  "agents": [...],
  "csi_state": { "claims": [...], "sources": [...], "trials": [...], "relations": [...], "recalls": [...], "actions": [...] },
  "report": { "report_id": "report_xxx", "title": "...", "markdown_content": "...", "status": "completed" },
  "config": { ... },
  "checkpoints": [...]
}
```

## 3. Backend Changes

### New endpoint: `POST /api/simulation/{simId}/bundle`

Bundles the simulation's CSI artifacts and pushes to HIVEMIND.

**Called:** automatically after report generation completes, or manually via API.

**Implementation:**
1. Read all CSI files from `uploads/simulations/{simId}/csi/`
2. Read report from `uploads/simulations/{simId}/` or report API
3. Read agent profiles, config, checkpoints
4. Compress with zlib, encode base64
5. `POST /api/memories` to HIVEMIND with the user's API key
6. Return bundle metadata

### New endpoint: `GET /api/simulation/{simId}/bundle`

Returns the compressed bundle (from local cache or HIVEMIND).

### Modified: report generation completion handler

After report status becomes `completed`, automatically trigger bundling.

### Files:
- Modify: `backend/app/api/simulation.py` — add `/bundle` endpoints
- Modify: `backend/app/services/simulation_persistence.py` — implement `create_and_push_bundle()`
- Modify: `backend/scripts/action_bundle.py` — update `CSIPackager` to include report + config + agents

## 4. Frontend Changes

### IndexedDB Cache (`utils/sessionCache.js`)

New utility for browser-side session caching:

```javascript
// Store/retrieve full session bundles in IndexedDB
sessionCache.save(simId, decompressedBundle)
sessionCache.get(simId) → bundle or null
sessionCache.list() → [{simId, title, timestamp}]
sessionCache.remove(simId)
```

### Sidebar (`AppSidebar.vue`)

Session list now comes from two sources (merged, deduped):
1. **HIVEMIND** — `GET /api/memories?tags=csi/bundle` via MiroFish backend proxy
2. **IndexedDB** — local cache for offline/fast access

### Persistence utility (`utils/persistence.js`)

Rewrite to use the new flow:
- `persistSession(simId)` — calls backend `/bundle` endpoint
- `unveilSession(simId)` — fetches bundle from HIVEMIND, decompresses, saves to IndexedDB
- `listSessions()` — merges HIVEMIND + IndexedDB lists

### Auto-persist trigger

After report generation completes (in `SimulationView.vue` or `Step3Simulation.vue`), call `persistSession()`.

### Files:
- Create: `frontend/src/utils/sessionCache.js` — IndexedDB wrapper
- Rewrite: `frontend/src/utils/persistence.js` — bundle push/pull
- Modify: `frontend/src/components/ui/AppSidebar.vue` — session list from HIVEMIND
- Modify: `frontend/src/views/SimulationView.vue` — auto-persist after report
- Modify: `frontend/src/api/simulation.js` — add bundle API functions

## 5. HIVEMIND Integration

Uses existing `POST /api/memories` and `GET /api/memories` endpoints with API key auth.

**Auth:** User's HIVEMIND API key (stored in `safeStorage` after "Connect HIVEMIND").

**No new HIVEMIND endpoints needed.** The `csi/bundle` tag separates CSI bundles from regular memories.

## 6. What Is NOT In Scope

- Removing the MiroFish backend filesystem storage (it stays as a write-through cache)
- Real-time sync during simulation (only sync after report completion)
- Sharing sessions between users
- Bundle encryption
- Incremental sync (full bundle per session)

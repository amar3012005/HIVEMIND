# CSI Bundle Persistence — Implementation Plan

> **For agentic workers:** Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** After report generation, bundle CSI artifacts and push to HIVEMIND. Sidebar shows sessions from HIVEMIND. Past sessions unveil from cloud to browser cache.

**Spec:** `docs/superpowers/specs/2026-04-15-csi-bundle-persistence-design.md`

---

## Task 1: IndexedDB Session Cache (`sessionCache.js`)

**Create:** `frontend/src/utils/sessionCache.js`

A simple IndexedDB wrapper for storing decompressed session bundles in the browser.

```javascript
const DB_NAME = 'mirofish_sessions'
const STORE_NAME = 'bundles'
const DB_VERSION = 1

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = (e) => {
      const db = e.target.result
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'simulation_id' })
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export const sessionCache = {
  async save(simId, bundle) {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).put({ simulation_id: simId, ...bundle, cached_at: Date.now() })
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  },

  async get(simId) {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).get(simId)
      req.onsuccess = () => resolve(req.result || null)
      req.onerror = () => reject(req.error)
    })
  },

  async list() {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readonly')
      const req = tx.objectStore(STORE_NAME).getAll()
      req.onsuccess = () => resolve((req.result || []).map(b => ({
        simulation_id: b.simulation_id,
        query: b.query || '',
        timestamp: b.timestamp || b.cached_at,
        claim_count: b.csi_state?.claims?.length || 0
      })))
      req.onerror = () => reject(req.error)
    })
  },

  async remove(simId) {
    const db = await openDB()
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite')
      tx.objectStore(STORE_NAME).delete(simId)
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
  }
}
```

---

## Task 2: Backend Bundle Endpoints

**Modify:** `backend/app/api/simulation.py`
**Modify:** `backend/app/services/simulation_persistence.py`

### 2a. Update `CSIPackager` to include report + config + agents

**Modify:** `backend/scripts/action_bundle.py`

Update `create_bundle` to also include:
- `state.json` (simulation metadata)
- `simulation_config.json`
- `reddit_profiles.json` / `twitter_profiles.csv`
- Report data (fetched from report API)

The bundle format becomes:
```python
{
  "simulation_id": sim_id,
  "query": config.get("simulation_requirement", ""),
  "timestamp": datetime.now().isoformat(),
  "agents": profiles_data,
  "csi_state": csi_state_data,
  "report": report_data,
  "config": config_data,
  "checkpoints": state.get("checkpoints", []),
  "files": { ... }  # compressed CSI files as before
}
```

### 2b. Add `/bundle` POST endpoint

```python
@simulation_bp.route('/<simulation_id>/bundle', methods=['POST'])
def create_bundle(simulation_id):
    """Bundle CSI artifacts and push to HIVEMIND."""
    # 1. Build the full bundle (CSI state + report + config + agents)
    # 2. Compress with zlib + base64
    # 3. If user has HIVEMIND API key, push to HIVEMIND via POST /api/memories
    # 4. Return bundle metadata
```

### 2c. Add `/bundle` GET endpoint

```python
@simulation_bp.route('/<simulation_id>/bundle', methods=['GET'])
def get_bundle(simulation_id):
    """Get compressed bundle — from local cache or HIVEMIND."""
    # 1. Check local file (csi_bundle.json)
    # 2. If not found, try HIVEMIND GET /api/memories?tags=csi/bundle,session:{simId}
    # 3. Return compressed bundle
```

### 2d. Update `SimulationPersistence.finalize_and_persist()`

Rewrite to:
1. Build full bundle (not just CSI files — include report, config, agents)
2. Compress with zlib + base64
3. Save local copy (`csi_bundle.json`)
4. Push to HIVEMIND if API key is available
5. Return metadata

---

## Task 3: Frontend Persistence Utility Rewrite

**Rewrite:** `frontend/src/utils/persistence.js`

```javascript
import axios from 'axios'
import { sessionCache } from './sessionCache'
import { authService } from './auth'

export const persistence = {
  // After report completes — bundle and push to cloud
  async persistSession(simId) {
    const res = await axios.post(`/api/simulation/${simId}/bundle`)
    if (res.data?.success && res.data?.bundle) {
      // Also save to IndexedDB for fast local access
      await sessionCache.save(simId, res.data.bundle)
    }
    return res.data
  },

  // Fetch and unveil a past session
  async unveilSession(simId) {
    // 1. Check IndexedDB first
    const cached = await sessionCache.get(simId)
    if (cached) return cached

    // 2. Fetch from backend (which checks local then HIVEMIND)
    const res = await axios.get(`/api/simulation/${simId}/bundle`)
    if (res.data?.success && res.data?.bundle) {
      await sessionCache.save(simId, res.data.bundle)
      return res.data.bundle
    }
    throw new Error('Session not found')
  },

  // List sessions from HIVEMIND + local cache (merged)
  async listSessions() {
    const [cloudRes, localList] = await Promise.all([
      axios.get('/api/sessions/cloud').catch(() => ({ data: { sessions: [] } })),
      sessionCache.list().catch(() => [])
    ])
    // Merge and dedupe by simulation_id
    const map = new Map()
    for (const s of localList) map.set(s.simulation_id, { ...s, source: 'local' })
    for (const s of (cloudRes.data?.sessions || [])) map.set(s.simulation_id, { ...s, source: 'cloud' })
    return [...map.values()].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))
  }
}
```

---

## Task 4: Backend Cloud Sessions Proxy

**Add to:** `backend/app/api/simulation.py`

New endpoint that fetches session list from HIVEMIND (proxied through backend to avoid CORS):

```python
@simulation_bp.route('/sessions/cloud', methods=['GET'])
def list_cloud_sessions():
    """List CSI sessions stored in HIVEMIND."""
    api_key = request.headers.get('X-Hivemind-Key', '')
    if not api_key:
        # Try to read from stored profile
        return jsonify({"success": True, "sessions": []})
    
    response = requests.get(
        f"{HIVEMIND_API_URL}/api/memories",
        headers={"x-api-key": api_key},
        params={"tags": "csi/bundle", "limit": 30},
        timeout=10,
        verify=False
    )
    if response.status_code == 200:
        memories = response.json().get("memories", [])
        sessions = [{
            "simulation_id": m.get("metadata", {}).get("simulation_id", ""),
            "query": m.get("title", "").replace("CSI: ", ""),
            "timestamp": m.get("created_at", ""),
            "memory_id": m.get("id"),
            "claim_count": m.get("metadata", {}).get("claim_count", 0),
            "source_count": m.get("metadata", {}).get("source_count", 0),
        } for m in memories]
        return jsonify({"success": True, "sessions": sessions})
    return jsonify({"success": True, "sessions": []})
```

---

## Task 5: Wire Auto-Persist After Report

**Modify:** `frontend/src/views/SimulationView.vue`

In the `reportCompleted` watcher or `handleReportLoaded`, call `persistence.persistSession()`:

```javascript
watch(reportCompleted, async (completed) => {
  if (completed && currentSimulationId.value) {
    try {
      await persistence.persistSession(currentSimulationId.value)
      addLog('Session persisted to HIVEMIND')
    } catch (e) {
      addLog(`Persistence failed: ${e.message}`)
    }
  }
})
```

---

## Task 6: Sidebar Reads from HIVEMIND

**Modify:** `frontend/src/components/ui/AppSidebar.vue` or `App.vue`

Replace `getSimulationHistory()` calls with `persistence.listSessions()` which merges cloud + local:

In `App.vue` `loadSessions`:
```javascript
const loadSessions = async () => {
  try {
    const sessions = await persistence.listSessions()
    recentSessions.value = sessions.map(s => ({
      id: s.simulation_id,
      label: s.query?.substring(0, 50) || `Session ${s.simulation_id?.slice(-8)}`,
      simulationId: s.simulation_id,
      source: s.source
    }))
  } catch {
    // Fallback to local backend
    // ... existing getSimulationHistory code
  }
}
```

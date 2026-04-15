# Session Continuity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Allow users to submit follow-up queries to an existing completed simulation, continuing the CSI sandbox with cumulative artifacts and checkpoint history.

**Architecture:** One new backend endpoint (`/continue`) that checkpoints the current state and restarts the simulation with the new query. The CSI research engine gets a continuation prompt modifier. Frontend wires the chatbox and sidebar to support continuations.

**Tech Stack:** Python/Flask (backend), Vue 3 (frontend), existing CSI research engine

**Spec:** `docs/superpowers/specs/2026-04-15-session-continuity-design.md`

---

## File Map

| File | Action | Purpose |
|------|--------|---------|
| `backend/app/api/simulation.py` | Modify | Add `/continue` endpoint |
| `backend/app/services/simulation_manager.py` | Modify | Add `save_checkpoint()` and `continue_simulation()` methods |
| `backend/app/services/csi_research_engine.py` | Modify | Add continuation prompt context in `run_research_rounds()` |
| `frontend/src/api/simulation.js` | Modify | Add `continueSimulation()` API function |
| `frontend/src/views/SimulationView.vue` | Modify | Wire chatbox to call continue, handle response |
| `frontend/src/components/ui/AppSidebar.vue` | Modify | Show checkpoint timeline |

---

### Task 1: Backend — `save_checkpoint()` and `continue_simulation()` on SimulationManager

**Files:**
- Modify: `backend/app/services/simulation_manager.py`

- [ ] **Step 1: Add `save_checkpoint` method**

Add this method to the `SimulationManager` class. Find the class and add after the existing `get_simulation` or similar getter methods:

```python
def save_checkpoint(self, simulation_id: str) -> dict:
    """Save a checkpoint of the current simulation state before continuation."""
    sim_dir = os.path.join(self.upload_dir, 'simulations', simulation_id)
    meta_path = os.path.join(sim_dir, 'simulation_meta.json')
    
    if not os.path.exists(meta_path):
        raise ValueError(f"Simulation {simulation_id} not found")
    
    with open(meta_path, 'r') as f:
        meta = json.load(f)
    
    # Read CSI artifact counts
    csi_store = SimulationCSILocalStore(simulation_id)
    try:
        csi_state = csi_store.get_state()
        summary = csi_state.get('summary', {}) if csi_state else {}
    except Exception:
        summary = {}
    
    checkpoint = {
        "id": f"cp_{len(meta.get('checkpoints', [])) + 1:03d}",
        "query": meta.get("simulation_requirement", ""),
        "timestamp": datetime.now().isoformat(),
        "round_reached": meta.get("current_round", 0),
        "artifact_summary": {
            "claims": summary.get("claim_count", 0),
            "sources": summary.get("source_count", 0),
            "trials": summary.get("trial_count", 0),
            "relations": summary.get("relation_count", 0),
            "recalls": summary.get("recall_count", 0),
            "actions": summary.get("agent_action_count", 0),
        }
    }
    
    if "checkpoints" not in meta:
        meta["checkpoints"] = []
    meta["checkpoints"].append(checkpoint)
    
    with open(meta_path, 'w') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    
    logger.info("Saved checkpoint %s for simulation %s", checkpoint["id"], simulation_id)
    return checkpoint
```

- [ ] **Step 2: Add `continue_simulation` method**

Add right after `save_checkpoint`:

```python
def continue_simulation(self, simulation_id: str, new_query: str) -> dict:
    """Continue a completed simulation with a new query, keeping all artifacts."""
    sim_dir = os.path.join(self.upload_dir, 'simulations', simulation_id)
    meta_path = os.path.join(sim_dir, 'simulation_meta.json')
    
    if not os.path.exists(meta_path):
        raise ValueError(f"Simulation {simulation_id} not found")
    
    with open(meta_path, 'r') as f:
        meta = json.load(f)
    
    status = meta.get("status", "")
    if status in ("running", "preparing"):
        raise ValueError(f"Cannot continue simulation in '{status}' state. Wait for completion.")
    
    # Save checkpoint of current state
    checkpoint = self.save_checkpoint(simulation_id)
    
    # Update simulation with new query
    with open(meta_path, 'r') as f:
        meta = json.load(f)
    
    meta["simulation_requirement"] = new_query
    meta["status"] = "ready"
    meta["current_round"] = 0
    # Keep: config_generated, agents, profiles, all CSI data
    
    with open(meta_path, 'w') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    
    logger.info("Continued simulation %s with new query: %s", simulation_id, new_query[:80])
    
    return {
        "checkpoint_id": checkpoint["id"],
        "previous_query": checkpoint["query"],
        "new_query": new_query,
        "artifacts_carried": checkpoint["artifact_summary"]
    }
```

- [ ] **Step 3: Add the `datetime` import if not already present**

Check the top of `simulation_manager.py` — if `datetime` is not imported, add:

```python
from datetime import datetime
```

- [ ] **Step 4: Commit**

```bash
git add MiroFish/backend/app/services/simulation_manager.py
git commit -m "feat: add save_checkpoint and continue_simulation to SimulationManager"
```

---

### Task 2: Backend — `/continue` API endpoint

**Files:**
- Modify: `backend/app/api/simulation.py`

- [ ] **Step 1: Add the `/continue` endpoint**

Add this endpoint in `simulation.py`, after the existing `/start` route (around line 2100):

```python
@simulation_bp.route('/<simulation_id>/continue', methods=['POST'])
def continue_simulation(simulation_id):
    """
    Continue a completed simulation with a new follow-up query.
    Keeps all existing CSI artifacts and agents. Creates a checkpoint
    of the previous state.
    
    Request (JSON):
        {
            "query": "new follow-up question"
        }
    
    Response:
        {
            "success": true,
            "data": {
                "checkpoint_id": "cp_001",
                "previous_query": "old question",
                "new_query": "new question",
                "artifacts_carried": { "claims": 14, "sources": 38, ... }
            }
        }
    """
    try:
        data = request.get_json() or {}
        query = data.get('query', '').strip()
        
        if not query:
            return jsonify({
                "success": False,
                "error": "query is required"
            }), 400
        
        manager = SimulationManager()
        result = manager.continue_simulation(simulation_id, query)
        
        return jsonify({
            "success": True,
            "data": result
        })
        
    except ValueError as e:
        return jsonify({
            "success": False,
            "error": str(e)
        }), 400
    except Exception as e:
        logger.error("Continue simulation failed: %s", str(e))
        logger.error(traceback.format_exc())
        return jsonify({
            "success": False,
            "error": f"Failed to continue simulation: {str(e)}"
        }), 500
```

- [ ] **Step 2: Add a GET endpoint for checkpoints**

Add this endpoint to retrieve checkpoint history:

```python
@simulation_bp.route('/<simulation_id>/checkpoints', methods=['GET'])
def get_checkpoints(simulation_id):
    """Get checkpoint history for a simulation."""
    try:
        manager = SimulationManager()
        sim_dir = os.path.join(manager.upload_dir, 'simulations', simulation_id)
        meta_path = os.path.join(sim_dir, 'simulation_meta.json')
        
        if not os.path.exists(meta_path):
            return jsonify({"success": False, "error": "Simulation not found"}), 404
        
        with open(meta_path, 'r') as f:
            meta = json.load(f)
        
        return jsonify({
            "success": True,
            "data": {
                "simulation_id": simulation_id,
                "checkpoints": meta.get("checkpoints", []),
                "current_query": meta.get("simulation_requirement", "")
            }
        })
    except Exception as e:
        logger.error("Get checkpoints failed: %s", str(e))
        return jsonify({"success": False, "error": str(e)}), 500
```

- [ ] **Step 3: Commit**

```bash
git add MiroFish/backend/app/api/simulation.py
git commit -m "feat: add /continue and /checkpoints API endpoints"
```

---

### Task 3: Backend — Continuation prompt in CSI Research Engine

**Files:**
- Modify: `backend/app/services/csi_research_engine.py`

- [ ] **Step 1: Add a continuation context builder method to `CSIResearchEngine`**

Add this method to the class, before `run_research_rounds`:

```python
def _build_continuation_context(self, simulation_requirement: str) -> str:
    """Build a continuation prompt prefix if this simulation has checkpoints."""
    sim_dir = os.path.join(
        Config.UPLOAD_FOLDER or 'uploads', 'simulations', self.simulation_id
    )
    meta_path = os.path.join(sim_dir, 'simulation_meta.json')
    
    try:
        if not os.path.exists(meta_path):
            return ""
        with open(meta_path, 'r') as f:
            meta = json.load(f)
        
        checkpoints = meta.get("checkpoints", [])
        if not checkpoints:
            return ""
        
        last_cp = checkpoints[-1]
        summary = last_cp.get("artifact_summary", {})
        
        context = (
            f"\nPRIOR RESEARCH CONTEXT:\n"
            f"You are continuing research in an active sandbox.\n"
            f"Previous goal: \"{last_cp.get('query', 'unknown')}\"\n"
            f"Current goal: \"{simulation_requirement}\"\n\n"
            f"Existing artifacts available to you:\n"
            f"- {summary.get('claims', 0)} claims (use RECALL to access them before proposing new ones)\n"
            f"- {summary.get('sources', 0)} sources (reuse before searching for new ones)\n"
            f"- {summary.get('trials', 0)} trials (previous verification results still valid)\n\n"
            f"RULES FOR CONTINUATION:\n"
            f"1. RECALL existing claims and sources FIRST before any SEARCH_WEB\n"
            f"2. If an existing claim is relevant to the new goal, reference it — do not duplicate\n"
            f"3. Only SEARCH_WEB when existing sources are insufficient for the new goal\n"
            f"4. New claims should BUILD ON existing ones, not contradict without evidence\n"
        )
        
        logger.info(
            "Continuation context built for simulation %s (checkpoint %s)",
            self.simulation_id, last_cp.get("id", "?")
        )
        return context
        
    except Exception as e:
        logger.warning("Failed to build continuation context: %s", str(e))
        return ""
```

- [ ] **Step 2: Inject continuation context into `run_research_rounds`**

In the `run_research_rounds` method, right after the logger.info at the start (around line 442), add:

```python
        # Inject continuation context if this is a continued session
        continuation_context = self._build_continuation_context(simulation_requirement)
        if continuation_context:
            simulation_requirement = continuation_context + "\n\n" + simulation_requirement
            logger.info("Continuation context injected into simulation requirement")
```

This prepends the continuation rules to the `simulation_requirement` string that gets passed to every agent's investigation and proposal phases.

- [ ] **Step 3: Add the `import os` if not already present**

Check imports at the top of `csi_research_engine.py`. Add `import os` if missing.

- [ ] **Step 4: Commit**

```bash
git add MiroFish/backend/app/services/csi_research_engine.py
git commit -m "feat: add continuation prompt context to CSI research engine"
```

---

### Task 4: Frontend — API function

**Files:**
- Modify: `frontend/src/api/simulation.js`

- [ ] **Step 1: Add `continueSimulation` and `getCheckpoints` API functions**

Add at the end of `simulation.js`:

```javascript
/**
 * Continue a completed simulation with a new follow-up query.
 * Keeps all existing CSI artifacts and creates a checkpoint.
 * @param {string} simulationId
 * @param {string} query - the new follow-up question
 */
export const continueSimulation = (simulationId, query) => {
  return service.post(`/api/simulation/${simulationId}/continue`, { query })
}

/**
 * Get checkpoint history for a simulation.
 * @param {string} simulationId
 */
export const getCheckpoints = (simulationId) => {
  return service.get(`/api/simulation/${simulationId}/checkpoints`)
}
```

- [ ] **Step 2: Commit**

```bash
git add MiroFish/frontend/src/api/simulation.js
git commit -m "feat: add continueSimulation and getCheckpoints API functions"
```

---

### Task 5: Frontend — Wire chatbox for continuation

**Files:**
- Modify: `frontend/src/views/SimulationView.vue`

- [ ] **Step 1: Add continuation state and handler**

In the `<script setup>` section, after the existing `tokenUsage` ref, add:

```javascript
const continuationLoading = ref(false)

const handleContinuation = async (query) => {
  if (!query.trim() || !currentSimulationId.value) return
  continuationLoading.value = true
  trackTokens(query, 'input')
  addLog(`Follow-up query: ${query}`)
  
  try {
    const { continueSimulation: continueSimAPI } = await import('../api/simulation')
    const res = await continueSimAPI(currentSimulationId.value, query.trim())
    if (res?.success && res?.data) {
      addLog(`Checkpoint saved: ${res.data.checkpoint_id}`)
      addLog(`Artifacts carried: ${JSON.stringify(res.data.artifacts_carried)}`)
      addLog(`New goal: ${res.data.new_query}`)
      
      // Refresh workspace state
      await hydrateWorkspace({ initial: false })
      
      // Load updated checkpoints
      await loadCheckpoints()
      
      // Auto-start the new simulation round
      simulationUnlocked.value = true
      await selectStage('simulation')
    }
  } catch (err) {
    addLog(`Continuation failed: ${err.message}`)
  } finally {
    continuationLoading.value = false
  }
}
```

- [ ] **Step 2: Add checkpoint loading**

After `handleContinuation`, add:

```javascript
const checkpoints = ref([])

const loadCheckpoints = async () => {
  if (!currentSimulationId.value) return
  try {
    const { getCheckpoints } = await import('../api/simulation')
    const res = await getCheckpoints(currentSimulationId.value)
    if (res?.success && res?.data) {
      checkpoints.value = res.data.checkpoints || []
    }
  } catch {
    // best-effort
  }
}
```

Call `loadCheckpoints()` inside the existing `onMounted` block, after `loadSidebarHistory()`.

- [ ] **Step 3: Wire the chatbox in the template**

Find the chatbox in `App.vue` (or wherever it lives). The chatbox needs to call `handleContinuation` when the simulation is completed. Since the chatbox is in `App.vue` and the handler is in `SimulationView.vue`, the simplest approach is to add a chatbox directly in SimulationView.

Add this before the closing `</div>` of `.workspace-view`, after the `AgentDetailOverlay`:

```html
    <!-- Continuation chatbox (visible when simulation is completed) -->
    <div v-if="simulationCompleted && !continuationLoading" class="continuation-box">
      <input
        v-model="continuationQuery"
        type="text"
        class="continuation-input"
        placeholder="Ask a follow-up question..."
        @keydown.enter="handleContinuation(continuationQuery); continuationQuery = ''"
      />
      <button
        class="continuation-send"
        :disabled="!continuationQuery.trim()"
        @click="handleContinuation(continuationQuery); continuationQuery = ''"
      >Send</button>
    </div>
    <div v-if="continuationLoading" class="continuation-box loading">
      <span class="cont-loading-text">Starting follow-up research...</span>
    </div>
```

Add the ref:

```javascript
const continuationQuery = ref('')
```

- [ ] **Step 4: Add CSS for the continuation box**

Add to the `<style scoped>` section:

```css
.continuation-box {
  position: absolute;
  bottom: 20px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 45;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 50vw;
  max-width: 600px;
  padding: 8px 12px;
  background: #fff;
  border: 1px solid #e3e0db;
  border-radius: 12px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}

.continuation-box.loading {
  justify-content: center;
}

.continuation-input {
  flex: 1;
  border: none;
  outline: none;
  font-size: 13px;
  font-family: 'Space Grotesk', system-ui, sans-serif;
  color: #0a0a0a;
  background: transparent;
}

.continuation-input::placeholder {
  color: #a3a3a3;
}

.continuation-send {
  padding: 6px 14px;
  border: none;
  border-radius: 8px;
  background: #117dff;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  font-family: 'Space Grotesk', system-ui, sans-serif;
  transition: background 0.15s;
  flex-shrink: 0;
}

.continuation-send:hover:not(:disabled) {
  background: #0d5fcc;
}

.continuation-send:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

.cont-loading-text {
  font-size: 12px;
  color: #a3a3a3;
  font-family: 'Space Grotesk', system-ui, sans-serif;
}
```

- [ ] **Step 5: Commit**

```bash
git add MiroFish/frontend/src/views/SimulationView.vue
git commit -m "feat: wire continuation chatbox and checkpoint loading in SimulationView"
```

---

### Task 6: Frontend — Checkpoint timeline in sidebar

**Files:**
- Modify: `frontend/src/components/ui/AppSidebar.vue`

- [ ] **Step 1: Add `checkpoints` prop**

Add to the existing `defineProps`:

```javascript
  checkpoints: {
    type: Array,
    default: () => []
  }
```

- [ ] **Step 2: Add checkpoint timeline in the template**

Replace the current session card section with a version that shows checkpoints:

Find the "Current session" section and replace it with:

```html
      <!-- Current session + checkpoints -->
      <div v-if="activeSession" class="sb-nav-section">
        <span class="sb-section-label">Current Session</span>
        
        <!-- Checkpoints (previous queries) -->
        <div v-for="cp in checkpoints" :key="cp.id" class="sb-checkpoint">
          <div class="sb-cp-dot"></div>
          <div class="sb-cp-info">
            <span class="sb-cp-query">{{ cp.query }}</span>
            <span class="sb-cp-meta">{{ cp.round_reached }} rounds &middot; {{ cp.artifact_summary?.claims || 0 }} claims</span>
          </div>
        </div>
        
        <!-- Active query -->
        <div class="sb-session-card active">
          <span class="sb-session-text">{{ activeSession.title }}</span>
          <span class="sb-session-id">{{ activeSession.id }}</span>
        </div>
      </div>
```

- [ ] **Step 3: Add checkpoint CSS**

Add to the `<style scoped>` section:

```css
.sb-checkpoint {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 4px 10px;
  margin-left: 4px;
  border-left: 1px solid #e3e0db;
}

.sb-cp-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #d4d0ca;
  margin-top: 4px;
  flex-shrink: 0;
}

.sb-cp-info {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.sb-cp-query {
  font-size: 11px;
  color: #737373;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.sb-cp-meta {
  font-size: 9px;
  font-family: 'JetBrains Mono', monospace;
  color: #a3a3a3;
}
```

- [ ] **Step 4: Pass checkpoints from SimulationView**

In `SimulationView.vue`, update the `<AppSidebar>` usage to pass checkpoints:

```html
    <AppSidebar
      :collapsed="leftNavCollapsed"
      :activeSession="{ title: projectRequirementTitle, id: currentSimulationId }"
      :sessions="sidebarHistory"
      :checkpoints="checkpoints"
      @toggle="leftNavCollapsed = !leftNavCollapsed"
      @go-home="goHome"
      @select-session="navigateToSimulation"
    />
```

- [ ] **Step 5: Commit**

```bash
git add MiroFish/frontend/src/components/ui/AppSidebar.vue MiroFish/frontend/src/views/SimulationView.vue
git commit -m "feat: show checkpoint timeline in sidebar"
```

---

### Task 7: Verify end-to-end

- [ ] **Step 1: Start backend and frontend dev servers**

```bash
cd /Users/amar/HIVE-MIND/MiroFish/backend && python run.py &
cd /Users/amar/HIVE-MIND/MiroFish/frontend && npm run dev
```

- [ ] **Step 2: Run a simulation to completion**

Navigate to `http://localhost:3000`, submit a query, wait for Environment + Simulation to complete.

- [ ] **Step 3: Test continuation**

After simulation completes, verify:
1. The continuation chatbox appears at the bottom ("Ask a follow-up question...")
2. Type a follow-up query and press Enter
3. Backend creates a checkpoint and returns success
4. Sidebar shows the checkpoint timeline (previous query with round count + claims)
5. Simulation restarts with new query, keeping all existing CSI artifacts
6. Graph shows existing nodes + new nodes from the continuation

- [ ] **Step 4: Test checkpoint API**

```bash
curl http://localhost:5001/api/simulation/SIM_ID/checkpoints | python -m json.tool
```

Verify the checkpoints array contains the saved checkpoint.

- [ ] **Step 5: Commit any fixes**

```bash
git add -A MiroFish/
git commit -m "fix: address issues found during session continuity testing"
```

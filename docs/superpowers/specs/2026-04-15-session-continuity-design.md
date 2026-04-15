# Session Continuity — Cumulative CSI Research

**Date:** 2026-04-15
**Scope:** MiroFish backend (API + simulation engine) + frontend (chatbox, sidebar, SimulationView)

---

## Problem

Every new user query starts a fresh simulation — new agents, new CSI artifacts, no memory of prior research. Users who want to explore related follow-up questions must start from zero each time, losing all accumulated knowledge.

## Solution

Allow users to submit follow-up queries to an existing simulation. The system continues the CSI sandbox with the new goal while keeping all existing artifacts (claims, sources, trials, relations). Prior research becomes a checkpoint. Agents are instructed to prioritize existing artifacts before acquiring new sources.

---

## 1. Core Flow

### User submits follow-up query:

1. User types new query in the chatbox (bottom of SimulationView)
2. Frontend calls `POST /api/simulation/{simId}/continue` with `{ query: "new question" }`
3. Backend:
   - Saves a **checkpoint** of current state (query, timestamp, round reached, artifact counts)
   - Appends checkpoint to `simulation.checkpoints[]` array
   - Updates `simulation.simulation_requirement` to the new query
   - Resets round counter to 0
   - **Keeps all existing CSI artifacts** — claims, sources, trials, recalls, actions, relations stay in the graph
   - Starts a new CSI simulation run with existing agents
4. Frontend auto-switches to Simulation tab, shows new rounds running
5. Sidebar shows checkpoint timeline under "Current Session"

### What stays the same:
- Agent roster (same agents, same roles, same skills)
- All CSI artifacts (additive, never deleted)
- The knowledge graph (grows monotonically)
- Token counter (continues accumulating)

### What changes:
- Active query/goal
- Round counter resets to 0
- Agent system prompts get continuation context
- A new checkpoint entry is created

---

## 2. Backend

### New endpoint: `POST /api/simulation/{simId}/continue`

**Request:**
```json
{
  "query": "new follow-up question"
}
```

**Response:**
```json
{
  "success": true,
  "checkpoint_id": "cp_001",
  "previous_query": "original question",
  "new_query": "new follow-up question",
  "artifacts_carried": {
    "claims": 14,
    "sources": 38,
    "trials": 4,
    "relations": 50,
    "recalls": 26,
    "actions": 82
  }
}
```

**Validation:**
- Simulation must exist and be in status `completed`, `stopped`, or `ready`
- Query must be non-empty
- Returns 400 if simulation is still `running` (use hot-inject for that — future scope)

### Checkpoint schema

Stored in the simulation's JSON data file (alongside existing config):

```json
{
  "checkpoints": [
    {
      "id": "cp_001",
      "query": "what is the current state of Strait of Hormuz",
      "timestamp": "2026-04-15T10:30:00Z",
      "round_reached": 5,
      "artifact_summary": {
        "claims": 14,
        "sources": 38,
        "trials": 4,
        "relations": 50
      }
    }
  ]
}
```

### Implementation — files touched:

| File | Change |
|------|--------|
| `backend/app/api/simulation.py` | Add `/continue` endpoint |
| `backend/app/services/simulation_manager.py` | Add `save_checkpoint()` and `continue_simulation()` methods |
| `backend/app/services/csi_research_engine.py` | Add continuation prompt modifier — if `checkpoints` exist, prepend artifact context to agent system prompts |

### `save_checkpoint()` method:

```python
def save_checkpoint(self, simulation_id: str) -> dict:
    sim = self.get_simulation(simulation_id)
    csi_store = SimulationCSILocalStore(simulation_id)
    state = csi_store.get_state()
    
    checkpoint = {
        "id": f"cp_{len(sim.get('checkpoints', []))+1:03d}",
        "query": sim["simulation_requirement"],
        "timestamp": datetime.utcnow().isoformat(),
        "round_reached": sim.get("current_round", 0),
        "artifact_summary": {
            "claims": state.get("summary", {}).get("claim_count", 0),
            "sources": state.get("summary", {}).get("source_count", 0),
            "trials": state.get("summary", {}).get("trial_count", 0),
            "relations": state.get("summary", {}).get("relation_count", 0),
        }
    }
    
    if "checkpoints" not in sim:
        sim["checkpoints"] = []
    sim["checkpoints"].append(checkpoint)
    self._save_simulation(sim)
    return checkpoint
```

### `continue_simulation()` method:

```python
def continue_simulation(self, simulation_id: str, new_query: str) -> dict:
    checkpoint = self.save_checkpoint(simulation_id)
    
    sim = self.get_simulation(simulation_id)
    sim["simulation_requirement"] = new_query
    sim["status"] = "ready"
    sim["current_round"] = 0
    # Keep config_generated=True, keep agents, keep all CSI data
    self._save_simulation(sim)
    
    return {
        "checkpoint_id": checkpoint["id"],
        "previous_query": checkpoint["query"],
        "new_query": new_query,
        "artifacts_carried": checkpoint["artifact_summary"]
    }
```

---

## 3. CSI Research Engine — Continuation Prompt

When `simulation.checkpoints` is non-empty, the research engine prepends context to each agent's system prompt before the first round:

```
PRIOR RESEARCH CONTEXT:
You are continuing research in an active sandbox.
Previous goal: "{checkpoint.query}"
Current goal: "{new_query}"

Existing artifacts available to you:
- {N} claims (use RECALL to access them before proposing new ones)
- {N} sources (reuse before searching for new ones)
- {N} trials (previous verification results still valid)

RULES FOR CONTINUATION:
1. RECALL existing claims and sources FIRST before any SEARCH_WEB
2. If an existing claim is relevant to the new goal, reference it — do not duplicate
3. Only SEARCH_WEB when existing sources are insufficient for the new goal
4. New claims should BUILD ON existing ones, not contradict without evidence
```

This is checked once at simulation start:
```python
if simulation.get("checkpoints"):
    last_cp = simulation["checkpoints"][-1]
    continuation_context = build_continuation_prompt(last_cp, simulation["simulation_requirement"])
    # Prepend to each agent's system_prompt
```

No changes to the CSI engine's core ReAct loop, round execution, or claim/trial mechanics.

---

## 4. Frontend

### Chatbox (App.vue / SimulationView.vue)

The existing chatbox at the bottom of SimulationView becomes functional for continuation:

- When simulation status is `completed` or `stopped`, the chatbox is enabled
- User types a new query, hits send
- Frontend calls `POST /api/simulation/{simId}/continue`
- On success: refresh simulation state, auto-switch to Simulation tab
- The chatbox placeholder changes based on state:
  - Running: "Simulation in progress..." (disabled)
  - Completed: "Ask a follow-up question..." (enabled)
  - Environment: "Preparing..." (disabled)

### Sidebar checkpoints (AppSidebar.vue)

Under "Current Session", show a checkpoint timeline when checkpoints exist:

```
Current Session
├── cp_001: "Strait of Hormuz state" — 5 rounds, 14 claims
├── cp_002: "Iran sanctions impact" — 3 rounds, 8 new claims
└── (active) "Oil market disruption forecast" — running...
```

Each checkpoint shows: truncated query, round count, claim count. Not clickable to navigate — purely informational context.

### Files touched:

| File | Change |
|------|--------|
| `App.vue` or `SimulationView.vue` | Wire chatbox send to `/continue` when simulation is completed |
| `AppSidebar.vue` | Add checkpoint timeline under current session card |
| `SimulationView.vue` | Handle continuation response, refresh workspace state |
| `frontend/src/api/simulation.js` | Add `continueSimulation(simId, query)` API function |

---

## 5. What Is NOT In Scope

- **Hot-inject into running simulation** — future scope; this only works when simulation is completed/stopped
- **Agent roster changes** — agents are kept as-is; no adding/removing agents on continuation
- **Artifact pruning or archiving** — everything is additive, no relevance scoring
- **Blueprint mining** — no pattern detection from checkpoints (future scope)
- **Branching into separate simulations** — continuation modifies the same simulation; no fork
- **Checkpoint diff/comparison** — sidebar shows checkpoints as a list, not a visual diff

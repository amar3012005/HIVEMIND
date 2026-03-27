# CSI API Reference

All endpoints require authentication via `x-user-id` and `x-org-id` headers. Agent Swarm endpoints require Scale plan or higher.

---

## Execution

### POST /api/swarm/execute

Execute a goal through the cognitive runtime.

**Request:**
```json
{
  "goal": "capture_decision",
  "agent_id": "scanner_1",
  "max_steps": 10,
  "initial_context": { "rawContent": "...", "platform": "slack" },
  "budget": {
    "max_tokens": 50000,
    "max_cost_usd": 1.0,
    "max_wall_clock_ms": 60000
  },
  "routing": {
    "strategy": "force_softmax",
    "temperature": 1.0,
    "top_k": 3,
    "force_weights": {
      "goalAttraction": 1.0,
      "affordanceAttraction": 1.0,
      "blueprintPrior": 0.3,
      "social": 0.2,
      "momentum": 0.15,
      "conflictRepulsion": 1.0,
      "congestionRepulsion": 1.0,
      "costRepulsion": 1.0
    }
  },
  "promotion_threshold": 0.8,
  "promotion_rule_id": "default"
}
```

**Response:**
```json
{
  "goal": "capture_decision",
  "agentId": "scanner_1",
  "stepsExecuted": 2,
  "eventsLogged": 2,
  "finalState": {
    "context": {},
    "done": true,
    "failuresCount": 0
  },
  "chainSummary": {
    "toolSequence": ["detect_decision_candidate", "classify_decision"],
    "doneReason": "tool_signaled_completion",
    "successRate": 1.0,
    "totalLatencyMs": 450,
    "usedBlueprint": true,
    "blueprintChainSignature": "detect>classify>link>store"
  }
}
```

| Field | Default | Notes |
|-------|---------|-------|
| `goal` | required | Goal identifier for execution |
| `agent_id` | `agent_{userId}` | Agent performing the execution |
| `max_steps` | 10 | Capped at 50 |
| `initial_context` | `undefined` | Seed data passed into trail context |
| `budget.max_tokens` | 50000 | Token budget |
| `budget.max_cost_usd` | 1.0 | Cost ceiling |
| `budget.max_wall_clock_ms` | 60000 | Wall clock timeout |
| `routing.strategy` | `force_softmax` | Trail selection strategy |
| `routing.temperature` | 1.0 | Softmax temperature |
| `promotion_threshold` | 0.8 | Blueprint promotion threshold |

---

## Trails

### POST /api/swarm/trails

Create a new trail.

**Request:**
```json
{
  "goal_id": "capture_decision",
  "agent_id": "scanner_1",
  "kind": "raw",
  "next_action": {
    "tool": "detect_decision_candidate",
    "params_template": { "source": "slack" },
    "version": "1.0"
  },
  "confidence": 0.5,
  "weight": 0.5,
  "decay_rate": 0.05,
  "tags": ["decision"],
  "blueprint_meta": null
}
```

**Response (201):**
```json
{
  "id": "uuid",
  "goalId": "capture_decision",
  "agentId": "scanner_1",
  "status": "active",
  "kind": "raw",
  "blueprintMeta": null,
  "nextAction": { "tool": "detect_decision_candidate", "paramsTemplate": {}, "version": "1.0" },
  "steps": [],
  "executionEventIds": [],
  "successScore": 0,
  "confidence": 0.5,
  "weight": 0.5,
  "decayRate": 0.05,
  "tags": ["decision"],
  "createdAt": "2026-03-27T00:00:00.000Z"
}
```

### GET /api/swarm/trails?goal_id=X&kind=raw|blueprint

List trails for a goal. `goal_id` is required; `kind` is optional.

**Response:**
```json
{
  "trails": [ { "..." } ],
  "count": 5
}
```

---

## Blueprints

### POST /api/swarm/blueprints/mine

Trigger chain mining for a goal.

**Request:**
```json
{
  "goal_id": "capture_decision"
}
```

**Response:**
```json
{
  "promoted": 1,
  "candidates": 3,
  "newBlueprints": [
    {
      "chainSignature": "detect>classify>link>store",
      "sourceEventCount": 5,
      "version": 1
    }
  ]
}
```

### GET /api/swarm/blueprints?goal_id=X&state=active

List blueprints for a goal. `goal_id` is required; `state` (`active`|`deprecated`) is optional.

**Response:**
```json
{
  "blueprints": [
    {
      "id": "uuid",
      "chainSignature": "detect>classify>link>store",
      "state": "active",
      "version": 1,
      "promotionStats": { "successRate": 0.95, "count": 5 },
      "sourceEventCount": 5,
      "promotedAt": "2026-03-27T00:00:00.000Z",
      "actionSequence": ["detect", "classify", "link", "store"],
      "weight": 0.8
    }
  ],
  "count": 1
}
```

### PATCH /api/swarm/blueprints/:id

Update blueprint state. Supports optimistic concurrency via `expected_version`.

**Request:**
```json
{
  "state": "deprecated",
  "expected_version": 1
}
```

**Response:**
```json
{
  "id": "uuid",
  "chainSignature": "detect>classify>link>store",
  "state": "deprecated",
  "version": 1,
  "updated_at": "2026-03-27T00:00:00.000Z"
}
```

| Status | Condition |
|--------|-----------|
| 404 | Blueprint not found or trail is not kind `blueprint` |
| 409 | `expected_version` does not match current version |

---

## Agents

### POST /api/swarm/agents

Register an explicit agent.

**Request:**
```json
{
  "agent_id": "scanner_1",
  "role": "generalist",
  "model": "groq-llama3",
  "skills": ["decision_detection", "classification"]
}
```

**Response (201):**
```json
{
  "agent": {
    "agent_id": "scanner_1",
    "role": "generalist",
    "status": "active",
    "source": "explicit",
    "skills": ["decision_detection", "classification"],
    "model": "groq-llama3",
    "last_seen_at": "2026-03-27T00:00:00.000Z"
  }
}
```

Returns **409** if the agent already exists.

### GET /api/swarm/agents

List agents. Optional query params: `role`, `status`, `source`.

**Response:**
```json
{
  "agents": [
    {
      "agent_id": "scanner_1",
      "role": "generalist",
      "status": "active",
      "source": "explicit",
      "skills": ["decision_detection"],
      "last_seen_at": "2026-03-27T00:00:00.000Z"
    }
  ],
  "count": 1
}
```

### GET /api/swarm/agents/:agent_id

Get a single agent with its reputation data.

**Response:**
```json
{
  "agent": {
    "agent_id": "scanner_1",
    "role": "generalist",
    "status": "active",
    "source": "explicit",
    "skills": [],
    "last_seen_at": "2026-03-27T00:00:00.000Z"
  },
  "reputation": {
    "overall": 0.85,
    "perTool": { "detect_decision_candidate": 0.9, "classify_decision": 0.8 },
    "perBlueprint": { "detect>classify>link>store": 0.92 }
  }
}
```

Returns **404** if agent does not exist.

### PATCH /api/swarm/agents/:agent_id

Update agent fields.

**Request:**
```json
{
  "role": "specialist",
  "skills": ["decision_detection"],
  "status": "idle",
  "model_version": "v2"
}
```

**Response:**
```json
{
  "agent": { "...updated agent object..." }
}
```

Returns **404** if agent does not exist.

---

## Dashboard

All dashboard endpoints are read-only (GET). The `window` parameter accepts duration strings like `1d`, `7d`, `30d`.

### GET /api/swarm/dashboard/overview?window=7d

System-wide summary for the given time window.

**Response:**
```json
{
  "totalExecutions": 150,
  "successRate": 0.92,
  "activeAgents": 3,
  "activeBlueprints": 2,
  "avgStepsPerExecution": 2.4,
  "window": "7d"
}
```

### GET /api/swarm/dashboard/executions?limit=50&agent_id=X&goal=X&window=7d

Recent execution log. All query params are optional.

| Param | Default | Notes |
|-------|---------|-------|
| `limit` | 50 | Max rows returned |
| `agent_id` | - | Filter by agent |
| `goal` | - | Filter by goal |
| `window` | `7d` | Time window |

**Response:**
```json
{
  "executions": [
    {
      "goal": "capture_decision",
      "agentId": "scanner_1",
      "stepsExecuted": 2,
      "doneReason": "tool_signaled_completion",
      "usedBlueprint": true,
      "timestamp": "2026-03-27T00:00:00.000Z"
    }
  ],
  "count": 50
}
```

### GET /api/swarm/dashboard/blueprints?window=7d

Blueprint analytics for the given time window.

**Response:**
```json
{
  "blueprints": [
    {
      "chainSignature": "detect>classify>link>store",
      "state": "active",
      "usageCount": 42,
      "successRate": 0.95,
      "avgLatencyMs": 380
    }
  ],
  "count": 1
}
```

### GET /api/swarm/dashboard/agents?window=7d

Agent performance analytics.

**Response:**
```json
{
  "agents": [
    {
      "agent_id": "scanner_1",
      "executionCount": 50,
      "successRate": 0.92,
      "topTools": ["detect_decision_candidate", "classify_decision"],
      "reputation": 0.85
    }
  ],
  "count": 1
}
```

---

## Meta

### POST /api/swarm/meta/evaluate

Run batch meta-evaluation across recent executions.

**Request:**
```json
{
  "lookback_runs": 50,
  "goal_filter": "capture_decision",
  "agent_filter": "scanner_1"
}
```

**Response:**
```json
{
  "findings": [
    {
      "rule": "low_success_rate",
      "severity": "warning",
      "message": "Agent scanner_1 success rate dropped below 0.7",
      "recommendation": {
        "param": "routing.force_weights.goalAttraction",
        "from": 1.0,
        "to": 1.2
      }
    }
  ],
  "summary": {
    "runsAnalyzed": 50,
    "findingsCount": 1,
    "criticalCount": 0
  }
}
```

| Field | Default | Notes |
|-------|---------|-------|
| `lookback_runs` | 50 | Number of recent runs to analyze |
| `goal_filter` | - | Optional goal filter |
| `agent_filter` | - | Optional agent filter |

### GET /api/swarm/meta/parameters

List all tunable parameters.

**Response:**
```json
{
  "parameters": {
    "routing.force_weights.goalAttraction": {
      "value": 1.0,
      "min": 0,
      "max": 5.0,
      "description": "Attraction toward goal completion",
      "updated_by": "system",
      "updated_at": "2026-03-27T00:00:00.000Z"
    }
  },
  "count": 20
}
```

### GET /api/swarm/meta/parameters/:key

Get a single parameter with its change history.

**Response:**
```json
{
  "key": "routing.force_weights.goalAttraction",
  "current": 1.0,
  "history": [
    { "from": 0.8, "to": 1.0, "updated_by": "meta_evaluator", "updated_at": "2026-03-27T00:00:00.000Z" }
  ]
}
```

### POST /api/swarm/meta/apply

Atomically apply parameter changes. All changes succeed or none do.

**Request:**
```json
{
  "changes": [
    { "param": "routing.force_weights.goalAttraction", "value": 1.2 },
    { "param": "routing.temperature", "value": 0.8 }
  ],
  "updated_by": "admin"
}
```

**Response:**
```json
{
  "applied": true,
  "changes": [
    { "param": "routing.force_weights.goalAttraction", "from": 1.0, "to": 1.2 },
    { "param": "routing.temperature", "from": 1.0, "to": 0.8 }
  ]
}
```

### POST /api/swarm/meta/rollback

Rollback a single parameter to its previous value.

**Request:**
```json
{
  "param": "routing.force_weights.goalAttraction"
}
```

**Response:**
```json
{
  "rolled_back": true,
  "param": "routing.force_weights.goalAttraction",
  "from": 1.2,
  "to": 1.0
}
```

---

## System

### GET /api/swarm/executor/status

Health check and system overview.

**Response:**
```json
{
  "available": true,
  "store": "InMemoryStore",
  "tools": [
    "graph_query",
    "write_observation",
    "http_request",
    "detect_decision_candidate",
    "classify_decision",
    "link_decision_context",
    "store_decision",
    "extract_decision_options"
  ],
  "agents": {
    "total": 3,
    "active": 2,
    "idle": 1,
    "suspended": 0
  }
}
```

# Deep Research v3 — Engine Upgrades

**Date:** 2026-04-09
**Status:** Draft
**Scope:** 6 improvements to the Deep Research engine, ordered by priority

---

## 1. SSE Streaming (replaces polling)

### Problem
Frontend polls `/api/research/:sessionId/status` every 2 seconds via `setInterval`. This creates choppy UX (events arrive in batches of 0-N every 2s), wastes bandwidth, and adds 0-2s latency to every event.

### Design

**Backend** — New endpoint `GET /api/research/:sessionId/stream`

The researcher already calls `this._emit(type, data)` which pushes to `session.events[]`. Instead of only buffering, also write to an SSE response if one is open.

```
Client opens SSE connection
  → server holds res open, sets headers (text/event-stream, no-cache)
  → stores res reference on session object as session.sseClients[]
  → on each _emit(), iterate session.sseClients and write `data: ${JSON.stringify(event)}\n\n`
  → on research complete/failed, send final event with `event: done` and close
  → on client disconnect, remove from sseClients[]
```

**Frontend** — Replace `setInterval` polling with `EventSource`

```
const source = new EventSource(`/v1/proxy/research/${sessionId}/stream`);
source.onmessage = (e) => {
  const event = JSON.parse(e.data);
  setEvents(prev => [...prev, event]);
};
source.addEventListener('done', () => source.close());
```

Remove the polling `useEffect` entirely. Keep the status endpoint for page-reload recovery (fetch current state on mount, then switch to SSE).

**Control plane proxy** — The control plane proxies `/v1/proxy/research/*` to core. SSE requires the proxy to stream the response body through without buffering. If the proxy uses `fetch()`, pipe `res.body` through. If it buffers, SSE breaks.

### Files changed
- `core/src/server.js` — new `/api/research/:sessionId/stream` handler, modify session object to hold SSE clients
- `core/src/deep-research/researcher.js` — no change needed (`_emit` already pushes to `session.events`, server wires SSE on top)
- `frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx` — replace polling with EventSource, remove setInterval
- Control plane proxy — ensure streaming passthrough for SSE

### Risks
- Control plane proxy buffering could break SSE. Test with curl first.
- If client reconnects, they need to catch up. On reconnect, fetch `/status` for current events, then re-open SSE for new ones.

---

## 2. Parallel TaskStack (Phased)

### Problem
TaskStack executes all 8 dimensions sequentially (LIFO). A typical research run takes 60-90s per dimension × 8 = 8-12 minutes. Most dimensions are independent and could run concurrently.

### Design

**Three-wave execution model:**

| Wave | Dimensions | Rationale |
|------|-----------|-----------|
| 1 (parallel) | definition, mechanism, evidence, timeline | Independent foundation dimensions — no cross-dependencies |
| 2 (parallel) | stakeholders, comparison, implications | Build on Wave 1 findings — need definition/mechanism context |
| 3 (sequential) | gaps | Needs all prior findings to identify what's missing |

**Implementation in `researcher.js`:**

```javascript
// Wave 1: Run 4 dimensions concurrently
const wave1Tasks = tasks.filter(t => ['definition', 'mechanism', 'evidence', 'timeline'].includes(t.dimension));
const wave1Results = await Promise.allSettled(
  wave1Tasks.map(task => this._executeTask(task, userId, orgId, projectId, sessionId, trailStore))
);
// Merge findings from all wave1 results

// Wave 2: Run 3 dimensions concurrently (with wave1 findings as context)
const wave2Tasks = tasks.filter(t => ['stakeholders', 'comparison', 'implications'].includes(t.dimension));
const wave2Results = await Promise.allSettled(
  wave2Tasks.map(task => this._executeTask(task, userId, orgId, projectId, sessionId, trailStore))
);

// Wave 3: Sequential gaps analysis
const gapTask = tasks.find(t => t.dimension === 'gaps');
if (gapTask) await this._executeTask(gapTask, ...);
```

**TrailStore thread safety:** `trailStore.recordStep()` pushes to an array and calls `_persistTrail()`. Multiple concurrent tasks calling `recordStep` will interleave. Fix: add a `stepIndex` counter with atomic increment, and use a write queue for `_persistTrail` (debounce to batch concurrent writes).

```javascript
// In TrailStore constructor
this._stepCounter = 0;
this._persistQueue = null;

recordStep(sessionId, step) {
  step.stepIndex = this._stepCounter++;
  // ... push to buffer ...
  // Debounced persist (coalesce concurrent writes)
  if (!this._persistQueue) {
    this._persistQueue = setTimeout(async () => {
      this._persistQueue = null;
      await this._persistTrail(sessionId);
    }, 500);
  }
}
```

**Event emission:** Each parallel task emits events independently. The frontend receives them interleaved — this is fine and actually looks better (multiple agents working simultaneously).

### Expected speedup
- Wave 1: 4 tasks in parallel → ~1 task duration instead of 4 (~60-90s saved)
- Wave 2: 3 tasks in parallel → ~1 task duration instead of 3 (~60-90s saved)
- Wave 3: 1 task sequential
- **Total: ~3-4 minutes instead of 8-12 minutes (2-3x faster)**

### Files changed
- `core/src/deep-research/researcher.js` — `research()` method: replace sequential loop with wave-based `Promise.allSettled`
- `core/src/deep-research/trail-store.js` — atomic step counter, debounced persistence
- `core/src/deep-research/task-stack.js` — add `dimension` field to tasks, add `getTasksByWave()` method

### Risks
- Groq rate limits: 4 concurrent LLM calls may hit limits. Add retry with exponential backoff.
- Tavily rate limits: 4 concurrent web searches. The daily limit (`HIVEMIND_WEB_SEARCH_DAILY_LIMIT=50`) is per-org, not per-request, so this is fine per-search but burns budget faster.
- Memory pressure: 4 concurrent tasks each hold findings arrays. Manageable at current scale.

---

## 3. Blueprint-Guided Decomposition

### Problem
Blueprints are mined after research completes and stored as `kg/blueprint` nodes, but they're not used proactively to speed up new research. The `blueprintId` parameter exists in `researcher.research()` but there's no automatic suggestion flow.

### Design

**Proactive blueprint matching at research start:**

In `researcher.research()`, before `_selectDimensions()`:

```javascript
// 1. Check for matching blueprints
if (useBlueprints && !blueprintId) {
  const suggested = await this._suggestBlueprint(query, userId, orgId);
  if (suggested && suggested.relevanceScore > 0.85) {
    blueprintId = suggested.blueprintId;
    this._emit('research.blueprint_suggested', {
      blueprintId: suggested.blueprintId,
      name: suggested.name,
      relevanceScore: suggested.relevanceScore,
    });
  }
}

// 2. If blueprint found, use its pattern to pre-populate TaskStack
if (blueprintId) {
  const blueprint = await this._loadBlueprint(blueprintId, userId, orgId);
  if (blueprint?.pattern?.length > 0) {
    // Use blueprint's queryTemplate for each phase instead of generic dimensions
    tasks = blueprint.pattern.map(phase => ({
      id: randomUUID(),
      query: phase.queryTemplate.replace('{query}', query),
      dimension: phase.actionType,
      agent: phase.agent,
      minConfidence: phase.minConfidence,
      fromBlueprint: true,
    }));
    this._emit('research.using_blueprint', { blueprintId, taskCount: tasks.length });
  }
}
```

**`_suggestBlueprint` implementation:**

Query CSI for `kg/blueprint` nodes, score by:
- Semantic similarity between query and blueprint's source queries (via vector search)
- Domain match (regulatory, competitive, technical, academic)
- Success rate of the blueprint

```javascript
async _suggestBlueprint(query, userId, orgId) {
  const blueprints = await this.memoryStore.searchMemories({
    query,
    user_id: userId,
    org_id: orgId,
    tags: ['blueprint'],
    n_results: 5,
  });
  if (!blueprints?.length) return null;
  // Pick highest relevance score (from vector similarity)
  const best = blueprints[0];
  return {
    blueprintId: best.metadata?.blueprintId || best.id,
    name: best.title,
    relevanceScore: best.score || best.importance_score || 0.5,
    domain: best.metadata?.domain,
  };
}
```

### Files changed
- `core/src/deep-research/researcher.js` — add `_suggestBlueprint()`, integrate into `research()` before task decomposition
- No schema changes needed — blueprints already exist as CSI nodes

### Risks
- Low blueprint corpus initially — won't fire until enough research sessions have completed and been mined. Add a "seed blueprints" option with the 4 built-in templates (regulatory, competitive, technical, literature review).

---

## 4. Contradiction Resolution Agent

### Problem
Contradictions are detected by `_actVerify()` and stored with `unresolved: true`, but nothing resolves them. They accumulate as dead nodes in the graph.

### Design

**New method `_resolveContradiction()` called after verification:**

```javascript
async _resolveContradiction(contradiction, trailStore, sessionId, userId, orgId, projectId) {
  // 1. Extract the specific factual claim in dispute
  const disputeQuery = await this._llm(
    `Two sources disagree:\n` +
    `Claim A (${contradiction.claimA.source}): ${contradiction.claimA.content.slice(0, 300)}\n` +
    `Claim B (${contradiction.claimB.source}): ${contradiction.claimB.content.slice(0, 300)}\n\n` +
    `Write a specific search query to find a tiebreaker source that resolves this disagreement. ` +
    `Return ONLY the search query string, nothing else.`,
    { temperature: 0.3, maxTokens: 200 }
  );

  // 2. Search for tiebreaker
  const tiebreaker = await this._actSearchWeb(disputeQuery, userId, orgId, projectId, sessionId, trailStore);

  if (!tiebreaker?.content) {
    // Can't resolve — mark as investigated but unresolved
    contradiction.investigated = true;
    return { resolved: false, reason: 'No tiebreaker source found' };
  }

  // 3. LLM judges which claim the tiebreaker supports
  const verdict = await this._llm(
    `A disagreement exists:\n` +
    `Claim A: ${contradiction.claimA.content.slice(0, 300)}\n` +
    `Claim B: ${contradiction.claimB.content.slice(0, 300)}\n\n` +
    `Tiebreaker source: ${tiebreaker.content.slice(0, 500)}\n\n` +
    `Return JSON: { "supports": "A" or "B" or "neither", "confidence": 0.0-1.0, "reasoning": "brief explanation" }`,
    { temperature: 0.2, maxTokens: 300 }
  );

  // 4. Parse and update contradiction
  const result = JSON.parse(verdict);
  contradiction.unresolved = false;
  contradiction.resolution = {
    supports: result.supports,
    confidence: result.confidence,
    reasoning: result.reasoning,
    tiebreakerSource: tiebreaker.source,
    resolvedAt: new Date().toISOString(),
  };

  // 5. Persist updated contradiction
  await trailStore.recordContradiction(sessionId, contradiction);

  this._emit('verifier.contradiction_resolved', {
    dimension: contradiction.dimension,
    supports: result.supports,
    confidence: result.confidence,
  });

  return { resolved: true, ...result };
}
```

**Integration point:** After `_actVerify()` in `_executeTask()` (Phase 5), iterate `verification.contradictions` and call `_resolveContradiction()` for each.

**Frontend:** Add a new event type `verifier.contradiction_resolved` to `EventCard` with a green/resolved indicator. Update the graph to show resolved contradictions with a different edge style (dashed → solid).

### Files changed
- `core/src/deep-research/researcher.js` — add `_resolveContradiction()`, call from Phase 5
- `frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx` — handle `verifier.contradiction_resolved` event

### Risks
- Each contradiction resolution costs 2 LLM calls + 1 web search. Cap at 3 contradiction resolutions per research session to bound cost.
- Tiebreaker search may return irrelevant results. The LLM verdict should handle this via the "neither" option.

---

## 5. Memory-First Retrieval

### Problem
`_actSearchMemory()` is called in Phase 4 (Analysis) as a side-channel. It's not in the hot path before web search. Past research findings, trails, and sources sit in CSI but aren't leveraged to avoid redundant web searches.

### Design

**Move memory search to the beginning of each task, before web search:**

In `_executeTask()`, before the ReAct loop:

```javascript
// Check memory FIRST — skip web search if high-confidence memory match exists
const memoryResult = await this._actSearchMemory(task.query, userId, orgId, projectId);
if (memoryResult?.content && memoryResult.confidence > 0.80) {
  // Memory has a strong match — use it as a finding without web search
  const finding = {
    id: randomUUID(),
    type: 'memory',
    title: memoryResult.title,
    content: memoryResult.content,
    source: 'hivemind_memory',
    sourceId: memoryResult.sourceId,
    confidence: memoryResult.confidence,
    taskQuery: task.query,
    agent: 'explorer',
  };
  findings.push(finding);
  this._emit('memory.cache_hit', {
    taskId: task.id,
    title: memoryResult.title,
    confidence: memoryResult.confidence,
  });

  // Still do web search but with fewer steps (2 instead of 3)
  // This validates memory findings against fresh sources
  maxExplorationSteps = 2;
} else {
  maxExplorationSteps = 3; // Normal web exploration
}
```

**Enhance `_actSearchMemory` to search across projects:**

Currently it searches within the current project. For memory-first retrieval to compound, it should also search across all research projects for the user:

```javascript
async _actSearchMemory(query, userId, orgId, projectId) {
  // Search current project first
  const projectResults = await this.recallFn(query, userId, orgId, { project: projectId, n_results: 5 });

  // Then search globally (cross-project)
  const globalResults = await this.recallFn(query, userId, orgId, { n_results: 10 });

  // Merge and deduplicate, prefer project-specific results
  // ...
}
```

### Files changed
- `core/src/deep-research/researcher.js` — move `_actSearchMemory` call to start of `_executeTask`, add confidence threshold logic, enhance cross-project search

### Risks
- Memory retrieval adds latency at task start (~200-500ms). Acceptable given it may save a full web search cycle (~3-5s).
- Stale memory: old findings may be outdated. Use `created_at` recency as a weighting factor — findings older than 30 days get a confidence penalty.

---

## 6. Confidence-Adaptive Depth

### Problem
`MAX_DEPTH` is hardcoded at 4 in TaskStack. Simple queries waste time going deep. Complex queries are cut short.

### Design

**Replace static MAX_DEPTH with adaptive logic in `researcher.research()`:**

```javascript
// After each wave completes, evaluate whether to continue
function shouldContinueResearch(findings, currentDepth) {
  const avgConfidence = findings.reduce((sum, f) => sum + f.confidence, 0) / findings.length;
  const contradictionCount = findings.filter(f => f.type === 'contradiction').length;

  // High confidence, no contradictions → stop early
  if (avgConfidence > 0.90 && contradictionCount === 0 && currentDepth >= 2) {
    return { continue: false, reason: 'high_confidence_early_stop' };
  }

  // Low confidence at depth 3 → extend and widen
  if (avgConfidence < 0.65 && currentDepth >= 3) {
    return {
      continue: true,
      maxDepth: 6,
      widen: true, // Switch to crawl mode for top domains
      reason: 'low_confidence_extension',
    };
  }

  // Normal progression
  if (currentDepth < 4) {
    return { continue: true, reason: 'normal' };
  }

  return { continue: false, reason: 'max_depth_reached' };
}
```

**Emit depth decisions as events:**
```javascript
this._emit('research.depth_decision', {
  currentDepth,
  avgConfidence,
  decision: result.reason,
  newMaxDepth: result.maxDepth,
});
```

### Files changed
- `core/src/deep-research/researcher.js` — add `shouldContinueResearch()`, call after each wave
- `core/src/deep-research/task-stack.js` — make `MAX_DEPTH` mutable per-session

### Risks
- Early stopping may miss important nuances. The 0.90 threshold is conservative — can tune based on production data.
- Extended runs (depth 6) could be expensive. Cap total LLM calls per session at 40.

---

## Priority & Dependency Order

```
┌─────────────────────────────────────────────────────────────┐
│ Phase 1: SSE Streaming                                      │
│ No dependencies. Improves UX immediately.                   │
│ Backend: 1 new endpoint. Frontend: replace polling.         │
├─────────────────────────────────────────────────────────────┤
│ Phase 2: Parallel TaskStack (Phased Waves)                  │
│ Depends on: SSE (parallel events need streaming to display) │
│ Core change to researcher.js execution model.               │
├─────────────────────────────────────────────────────────────┤
│ Phase 3: Blueprint-Guided Decomposition                     │
│ Independent. Can be done in parallel with Phase 2.          │
│ Quick win — mostly wiring existing pieces.                  │
├─────────────────────────────────────────────────────────────┤
│ Phase 4: Contradiction Resolution Agent                     │
│ Independent. Adds new method to researcher.js.              │
│ Best done after Phase 2 (verifier runs in wave context).    │
├─────────────────────────────────────────────────────────────┤
│ Phase 5: Memory-First Retrieval                             │
│ Independent. Changes task execution hot path.               │
│ Best done after Phase 2 (each parallel task checks memory). │
├─────────────────────────────────────────────────────────────┤
│ Phase 6: Confidence-Adaptive Depth                          │
│ Depends on: Phase 2 (waves) + Phase 5 (memory confidence)  │
│ Needs confidence data from both to make good decisions.     │
└─────────────────────────────────────────────────────────────┘
```

**Suggested implementation order:**
1. SSE Streaming (unblocks everything)
2. Parallel TaskStack + Blueprint-Guided Decomposition (in parallel)
3. Contradiction Resolution Agent
4. Memory-First Retrieval
5. Confidence-Adaptive Depth (last — needs data from 2-4)

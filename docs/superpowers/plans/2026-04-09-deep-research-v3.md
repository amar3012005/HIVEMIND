# Deep Research v3 — Engine Upgrades Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade HIVEMIND Deep Research with SSE streaming, parallel task execution (3-wave model), blueprint-guided decomposition, contradiction resolution, memory-first retrieval, and confidence-adaptive depth.

**Architecture:** Replace polling with SSE on a new `/stream` endpoint. Refactor `researcher.research()` to execute dimension tasks in 3 parallel waves via `Promise.allSettled`. Add thread-safe step recording to TrailStore. Wire blueprint suggestion into the hot path before decomposition. Add a contradiction resolution method that does targeted tiebreaker searches. Move memory search before web search with a confidence gate. Make depth adaptive based on mid-run confidence.

**Tech Stack:** Node.js (core server), EventSource/SSE (streaming), Framer Motion + React (frontend), Prisma/PostgreSQL (persistence), Groq LLM API

**Spec:** `docs/superpowers/specs/2026-04-09-deep-research-v3-design.md`

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `core/src/server.js` | Modify | Add SSE `/stream` endpoint, wire `sseClients` on session object |
| `core/src/deep-research/researcher.js` | Modify | Wave-based parallel execution, memory-first retrieval, contradiction resolution, adaptive depth |
| `core/src/deep-research/task-stack.js` | Modify | Add `getTasksByWave()`, make `MAX_DEPTH` per-session, export wave groupings |
| `core/src/deep-research/trail-store.js` | Modify | Atomic step counter, debounced persistence for concurrent writes |
| `frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx` | Modify | Replace polling `useEffect` with `EventSource`, handle new event types |

---

## Task 1: SSE Streaming — Backend Endpoint

**Files:**
- Modify: `core/src/server.js:296` (session object) and `core/src/server.js:3216` (add stream handler before status handler)

- [ ] **Step 1: Add `sseClients` array to session object schema**

In `core/src/server.js`, find the session creation at the `/api/research/start` handler (around line 3759). Add `sseClients` to the session object:

```javascript
// In the /api/research/start handler, modify the session object:
const session = {
  id: sessionId,
  query,
  userId,
  orgId,
  projectId,
  status: 'running',
  events: [],
  sseClients: [],  // ← ADD THIS
  result: null,
  error: null,
  createdAt: new Date().toISOString(),
};
```

- [ ] **Step 2: Add SSE broadcast to the `onEvent` callback**

In the same `/api/research/start` handler, modify the `onEvent` callback that's passed to `DeepResearcher`:

```javascript
// Replace:
onEvent: (event) => { session.events.push(event); },

// With:
onEvent: (event) => {
  session.events.push(event);
  // Broadcast to all SSE clients
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  session.sseClients = session.sseClients.filter(client => {
    try {
      client.write(payload);
      return true;
    } catch {
      return false; // Remove dead clients
    }
  });
},
```

- [ ] **Step 3: Add the `/api/research/:sessionId/stream` endpoint**

In `core/src/server.js`, add this handler BEFORE the existing session routes block (before the `if (action === 'status' || !action)` check, around line 3218). Insert it right after the `if (!session)` guard:

```javascript
        // SSE stream endpoint
        if (action === 'stream') {
          res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            'Connection': 'keep-alive',
            'X-Accel-Buffering': 'no',  // Disable nginx buffering
          });

          // Send existing events as catch-up
          for (const event of session.events) {
            res.write(`data: ${JSON.stringify(event)}\n\n`);
          }

          // If already done, send final event and close
          if (session.status === 'completed' || session.status === 'failed') {
            res.write(`event: done\ndata: ${JSON.stringify({
              status: session.status,
              error: session.error || null,
            })}\n\n`);
            res.end();
            return;
          }

          // Register this client for live events
          session.sseClients.push(res);

          // Clean up on disconnect
          req.on('close', () => {
            session.sseClients = session.sseClients.filter(c => c !== res);
          });

          // Don't end the response — keep it open
          return;
        }
```

- [ ] **Step 4: Send `done` event when research completes or fails**

In the `/api/research/start` handler, find the `.then()` and `.catch()` on `researcher.research()` (around line 3803). Add SSE close:

```javascript
researcher.research(query, userId, orgId, { /* ... */ })
  .then(result => {
    session.status = 'completed';
    session.result = result;
    // Notify SSE clients
    const donePayload = `event: done\ndata: ${JSON.stringify({ status: 'completed' })}\n\n`;
    session.sseClients.forEach(client => {
      try { client.write(donePayload); client.end(); } catch {}
    });
    session.sseClients = [];
    if (planEnforcer && orgId) {
      planEnforcer.recordUsage(orgId, 'deepResearch', 1);
    }
  })
  .catch(err => {
    session.status = 'failed';
    session.error = err.message;
    // Notify SSE clients
    const donePayload = `event: done\ndata: ${JSON.stringify({ status: 'failed', error: err.message })}\n\n`;
    session.sseClients.forEach(client => {
      try { client.write(donePayload); client.end(); } catch {}
    });
    session.sseClients = [];
  });
```

- [ ] **Step 5: Test with curl**

```bash
# Start a research session
curl -X POST https://api.hivemind.davinciai.eu/api/research/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"query": "What is quantum computing?"}'

# Note the session_id, then stream:
curl -N https://api.hivemind.davinciai.eu/api/research/SESSION_ID/stream \
  -H "Authorization: Bearer $API_KEY"

# Expected: SSE events streaming in real-time, ending with event: done
```

- [ ] **Step 6: Commit**

```bash
git add core/src/server.js
git commit -m "feat(research): add SSE streaming endpoint for real-time events"
```

---

## Task 2: SSE Streaming — Frontend

**Files:**
- Modify: `frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx:668-724`

- [ ] **Step 1: Replace the polling `useEffect` with an SSE-based effect**

In `DeepResearch.jsx`, replace the entire polling `useEffect` block (lines 668-724) with:

```javascript
  /* ── SSE stream for real-time events ─────────────────────────── */
  useEffect(() => {
    if (!sessionId || status !== 'running') return;

    const baseUrl = apiClient.controlPlane.defaults?.baseURL || '';
    const streamUrl = `${baseUrl}/v1/proxy/research/${sessionId}/stream`;

    const source = new EventSource(streamUrl, { withCredentials: true });

    source.onmessage = (e) => {
      try {
        const event = JSON.parse(e.data);
        setEvents(prev => [...prev, event]);

        // Process agent state events
        if (event.type === 'agent.states' && event.states) {
          setAgentStates(prev => ({ ...prev, [event.taskId]: event.states }));
        } else if (event.type === 'agent.state') {
          setAgentStates(prev => ({
            ...prev,
            [event.taskId]: { ...(prev[event.taskId] || {}), [event.agent]: event.state }
          }));
        }

        // Update subgoals from task events
        if (event.type === 'task.started' && event.dimension) {
          setSubgoals(prev => {
            const exists = prev.find(g => g.id === event.taskId);
            if (exists) return prev;
            return [...prev, { id: event.taskId, query: event.query, dimension: event.dimension, status: 'running' }];
          });
        }
        if (event.type === 'task.completed') {
          setSubgoals(prev => prev.map(g => g.id === event.taskId ? { ...g, status: 'completed', confidence: event.confidence } : g));
        }

        // Refresh graph data periodically during streaming
        if (showPanel && event.type?.startsWith('task.completed')) {
          fetchGraphData(sessionId);
        }
      } catch (err) {
        console.error('[SSE] Failed to parse event:', err);
      }
    };

    source.addEventListener('done', async (e) => {
      const data = JSON.parse(e.data);
      source.close();

      if (data.status === 'completed') {
        setStatus('completed');
        try {
          const { data: rpt } = await apiClient.controlPlane.get(`/v1/proxy/research/${sessionId}/report`);
          setReport(rpt.report);
          setFindings(rpt.findings || []);
          setDurationMs(rpt.durationMs || 0);
          setConfidence(rpt.confidence ?? rpt.taskProgress?.overallConfidence ?? 0);
          setFromCache(!!rpt.fromCache);
          if (rpt.projectId) setProjectId(rpt.projectId);
          fetchTrailSteps(sessionId);
          fetchGraphData(sessionId);
        } catch (e) {
          console.error('Failed to fetch report:', e);
        }
      } else if (data.status === 'failed') {
        setStatus('failed');
        setError(data.error || 'Research failed');
      }
    });

    source.onerror = (err) => {
      console.error('[SSE] Connection error, falling back to polling:', err);
      source.close();
      // Fallback: single status fetch to recover state
      apiClient.controlPlane.get(`/v1/proxy/research/${sessionId}/status`)
        .then(({ data }) => {
          setEvents(data.events || []);
          if (data.status === 'completed') setStatus('completed');
          if (data.status === 'failed') { setStatus('failed'); setError(data.error); }
        })
        .catch(() => {});
    };

    return () => source.close();
  }, [sessionId, status, showPanel, fetchTrailSteps, fetchGraphData]);
```

- [ ] **Step 2: Verify EventSource URL works with the control plane proxy**

The control plane at `api.hivemind.davinciai.eu` proxies to core. SSE requires the proxy to NOT buffer the response body. If the control plane uses `fetch()` internally, it must pipe `res.body` through as a readable stream. Check if `/v1/proxy/research/:sessionId/stream` passes through correctly:

```bash
# From browser console or curl:
curl -N "https://api.hivemind.davinciai.eu/v1/proxy/research/TEST_SESSION/stream" \
  -H "Cookie: session_cookie_here"
```

If the proxy buffers, you'll need to modify the control plane to detect `Accept: text/event-stream` and use streaming passthrough.

- [ ] **Step 3: Commit**

```bash
git add frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx
git commit -m "feat(research): replace polling with SSE streaming on frontend"
```

---

## Task 3: Parallel TaskStack — Wave Groupings

**Files:**
- Modify: `core/src/deep-research/task-stack.js`

- [ ] **Step 1: Add wave grouping constants and method**

At the top of `task-stack.js`, after the `DIMENSIONS` array (line 26), add:

```javascript
const WAVE_GROUPS = {
  1: ['definition', 'mechanism', 'evidence', 'timeline'],
  2: ['stakeholders', 'comparison', 'implications'],
  3: ['gaps'],
};
```

- [ ] **Step 2: Add `getTasksByWave()` method to TaskStack class**

Add this method after `decompose()` (after line 161):

```javascript
  /**
   * Group pending dimension tasks into execution waves.
   * Wave 1: Independent foundation dimensions (run in parallel)
   * Wave 2: Contextual dimensions (need wave 1 results, run in parallel)
   * Wave 3: Gap analysis (needs everything, runs sequentially)
   * @returns {{ 1: Task[], 2: Task[], 3: Task[] }}
   */
  getTasksByWave() {
    const waves = { 1: [], 2: [], 3: [] };
    for (const [, task] of this.tasks) {
      if (task.status !== 'pending' || !task.dimension) continue;
      for (const [wave, dims] of Object.entries(WAVE_GROUPS)) {
        if (dims.includes(task.dimension)) {
          waves[wave].push(task);
          break;
        }
      }
    }
    return waves;
  }
```

- [ ] **Step 3: Make MAX_DEPTH configurable per-session**

Replace the `const MAX_DEPTH = 4;` at line 12 with:

```javascript
let DEFAULT_MAX_DEPTH = 4;
```

And in the `TaskStack` constructor, accept an optional `maxDepth`:

```javascript
  constructor({ maxDepth } = {}) {
    this.tasks = new Map();
    this.stack = [];
    this.completed = [];
    this.rootId = null;
    this.maxDepth = maxDepth || DEFAULT_MAX_DEPTH;
  }
```

Update the `complete()` method at line 95 to use `this.maxDepth` instead of `MAX_DEPTH`:

```javascript
    if (gaps.length > 0 && task.depth < this.maxDepth && this.tasks.size < MAX_TASKS) {
```

And `getRemainingGaps()` at line 229:

```javascript
      if (task.status === 'completed' && task.gaps.length > 0 && task.depth >= this.maxDepth) {
```

- [ ] **Step 4: Export new constants**

Update the export at line 271:

```javascript
export { DIMENSIONS, WAVE_GROUPS, DEFAULT_MAX_DEPTH as MAX_DEPTH, MAX_TASKS, CONFIDENCE_THRESHOLD };
```

- [ ] **Step 5: Commit**

```bash
git add core/src/deep-research/task-stack.js
git commit -m "feat(research): add wave groupings and configurable depth to TaskStack"
```

---

## Task 4: Parallel TaskStack — Thread-Safe TrailStore

**Files:**
- Modify: `core/src/deep-research/trail-store.js:28-36` (constructor) and `core/src/deep-research/trail-store.js:98-136` (recordStep)

- [ ] **Step 1: Add atomic step counter and debounced persist to constructor**

In `trail-store.js`, modify the constructor (lines 28-36):

```javascript
  constructor({ memoryStore, userId, orgId }) {
    this.memoryStore = memoryStore;
    this.userId = userId;
    this.orgId = orgId;

    // In-memory buffer for building trail before persistence
    this.trails = new Map();
    this.contradictions = new Map();

    // Thread-safe step recording for parallel task execution
    this._stepCounter = 0;
    this._persistTimers = new Map(); // sessionId → timer
  }
```

- [ ] **Step 2: Update `recordStep` for atomic indexing and debounced persistence**

Replace the `recordStep` method (lines 98-136):

```javascript
  async recordStep(sessionId, step) {
    const trail = this.trails.get(sessionId);
    if (!trail) {
      await this.initTrail(sessionId, 'Unknown', `research/unknown`);
    }

    const trailBuffer = this.trails.get(sessionId);
    const stepRecord = {
      stepIndex: this._stepCounter++,  // Atomic increment
      agent: step.agent || 'explorer',
      action: step.action || 'search_web',
      input: step.input || '',
      output: step.output || '',
      confidence: step.confidence ?? 0.5,
      rejected: step.rejected || false,
      reason: step.reason || '',
      thought: step.thought || '',
      why: step.why || '',
      alternativeConsidered: step.alternativeConsidered || null,
      timestamp: new Date().toISOString(),
    };

    trailBuffer.steps.push(stepRecord);
    trailBuffer.metadata.updatedAt = new Date().toISOString();

    if (step.agent && trailBuffer.metadata.agentStates) {
      trailBuffer.metadata.agentStates[step.agent] = step.rejected ? 'blocked' : 'active';
    }

    // Debounced persist — coalesces concurrent writes within 500ms
    if (this._persistTimers.has(sessionId)) {
      clearTimeout(this._persistTimers.get(sessionId));
    }
    this._persistTimers.set(sessionId, setTimeout(async () => {
      this._persistTimers.delete(sessionId);
      try {
        await this._persistTrail(sessionId);
      } catch (err) {
        console.error('[TrailStore] Debounced persist failed:', err.message);
      }
    }, 500));

    return stepRecord;
  }
```

- [ ] **Step 3: Flush pending persists in `finalizeTrail`**

In the `finalizeTrail` method (lines 202-216), flush any pending debounced persist before final write:

```javascript
  async finalizeTrail(sessionId, report) {
    const trail = this.trails.get(sessionId);
    if (!trail) return null;

    // Flush any pending debounced persist
    if (this._persistTimers.has(sessionId)) {
      clearTimeout(this._persistTimers.get(sessionId));
      this._persistTimers.delete(sessionId);
    }

    trail.metadata.completedAt = new Date().toISOString();
    trail.metadata.report = report;
    trail.metadata.status = 'completed';

    await this._persistTrail(sessionId);

    // Clean up in-memory buffer after persistence
    setTimeout(() => this.trails.delete(sessionId), 60000);

    return trail;
  }
```

- [ ] **Step 4: Commit**

```bash
git add core/src/deep-research/trail-store.js
git commit -m "feat(research): thread-safe step recording with debounced persistence"
```

---

## Task 5: Parallel TaskStack — Wave Execution in Researcher

**Files:**
- Modify: `core/src/deep-research/researcher.js:140-200` (the sequential task loop in `research()`)

- [ ] **Step 1: Replace the sequential task loop with wave-based parallel execution**

In `researcher.js`, replace the code from line 140 (`// Step 1: Decompose into subtasks`) through line 200 (end of the `while(true)` loop) with:

```javascript
    // Step 1: Decompose into subtasks
    const stack = new TaskStack();
    const root = stack.createRoot(query);

    // Use LLM to pick relevant dimensions
    const dimensions = await this._selectDimensions(query);
    this._emit('research.decomposed', { sessionId, dimensions, taskCount: dimensions.length + 1 });

    if (dimensions.length > 0) {
      stack.decompose(root.id, dimensions);
    }

    // Step 2: Execute tasks in parallel waves
    const allFindings = [...priorFindings];
    const allSources = [];
    const waves = stack.getTasksByWave();

    for (const waveNum of [1, 2, 3]) {
      const waveTasks = waves[waveNum];
      if (!waveTasks || waveTasks.length === 0) continue;

      this._emit('research.wave_started', { sessionId, wave: waveNum, taskCount: waveTasks.length });

      // Emit task.started for each task in the wave
      for (const task of waveTasks) {
        this._emit('task.started', {
          sessionId,
          taskId: task.id,
          query: task.query,
          depth: task.depth,
          dimension: task.dimension,
          wave: waveNum,
          progress: stack.getProgress(),
        });
      }

      // Execute all tasks in this wave concurrently
      const results = await Promise.allSettled(
        waveTasks.map(async (task) => {
          try {
            const result = await this._executeTask(task, userId, orgId, projectId, sessionId, trailStore);

            stack.complete(task.id, {
              findings: result.findings,
              confidence: result.confidence,
              gaps: result.gaps,
            });

            // Save findings to CSI graph
            for (const finding of result.findings) {
              await this._saveFindingToCSI(finding, userId, orgId, projectId);
            }

            this._emit('task.completed', {
              sessionId,
              taskId: task.id,
              findingCount: result.findings.length,
              confidence: result.confidence,
              gaps: result.gaps,
              wave: waveNum,
              progress: stack.getProgress(),
            });

            return result;
          } catch (err) {
            stack.fail(task.id, err.message);
            this._emit('task.failed', { sessionId, taskId: task.id, error: err.message, wave: waveNum });
            return { findings: [], sources: [], confidence: 0, gaps: [err.message] };
          }
        })
      );

      // Collect all findings from this wave
      for (const r of results) {
        if (r.status === 'fulfilled' && r.value) {
          allFindings.push(...r.value.findings);
          allSources.push(...(r.value.sources || []));
        }
      }

      this._emit('research.wave_completed', {
        sessionId,
        wave: waveNum,
        findingCount: allFindings.length,
        confidence: stack.getAggregateConfidence(),
      });
    }

    // Also process any non-dimension tasks left on the stack (gap subtasks etc.)
    while (true) {
      const task = stack.next();
      if (!task) break;

      this._emit('task.started', { sessionId, taskId: task.id, query: task.query, depth: task.depth, dimension: task.dimension, progress: stack.getProgress() });

      try {
        const result = await this._executeTask(task, userId, orgId, projectId, sessionId, trailStore);
        stack.complete(task.id, { findings: result.findings, confidence: result.confidence, gaps: result.gaps });
        allFindings.push(...result.findings);
        allSources.push(...result.sources);
        for (const finding of result.findings) {
          await this._saveFindingToCSI(finding, userId, orgId, projectId);
        }
        this._emit('task.completed', { sessionId, taskId: task.id, findingCount: result.findings.length, confidence: result.confidence, progress: stack.getProgress() });
      } catch (err) {
        stack.fail(task.id, err.message);
        this._emit('task.failed', { sessionId, taskId: task.id, error: err.message });
      }
    }
```

- [ ] **Step 2: Update the `_executeTask` to mark tasks active when popping from wave**

In `_executeTask` (around line 275), the method currently expects a task already marked `active` by `stack.next()`. Since wave tasks bypass `stack.next()`, mark them active at the start:

```javascript
  async _executeTask(task, userId, orgId, projectId, sessionId, trailStore) {
    task.status = 'active';  // ← ADD THIS LINE at the very start
    const findings = [];
    // ... rest of method unchanged
```

- [ ] **Step 3: Handle new event types in frontend `EventCard`**

In `DeepResearch.jsx`, find the `EventCard` component's `getContent()` switch statement. Add cases for new wave events after the existing `research.decomposed` case:

```javascript
      case 'research.wave_started':
        return (
          <div className="flex items-center gap-3">
            <Layers size={14} className="text-[#117dff]" />
            <span className="text-xs text-[#525252]/70">
              Wave {event.wave}: Running {event.taskCount} dimensions in parallel
            </span>
          </div>
        );
      case 'research.wave_completed':
        return (
          <div className="flex items-center gap-3">
            <CheckCircle2 size={14} className="text-[#16a34a]" />
            <span className="text-xs text-[#16a34a]">
              Wave {event.wave} complete — {event.findingCount} findings ({(event.confidence * 100).toFixed(0)}% confidence)
            </span>
          </div>
        );
```

- [ ] **Step 4: Commit**

```bash
git add core/src/deep-research/researcher.js frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx
git commit -m "feat(research): parallel wave execution - 3 waves for 2-3x speedup"
```

---

## Task 6: Blueprint-Guided Decomposition

**Files:**
- Modify: `core/src/deep-research/researcher.js:75-90` (blueprint suggestion in `research()`)

- [ ] **Step 1: Enhance `_suggestBlueprint` to use vector search with relevance scoring**

Find `_suggestBlueprint` in `researcher.js` (search for `async _suggestBlueprint`). It already exists but may only search shallowly. Replace it with:

```javascript
  async _suggestBlueprint(query) {
    try {
      const results = await this.memoryStore.searchMemories({
        query,
        tags: ['blueprint'],
        n_results: 5,
      });
      if (!results?.length) return [];

      return results
        .filter(m => m.metadata?.blueprintId)
        .map(m => ({
          blueprintId: m.metadata.blueprintId,
          name: m.title || m.metadata.name,
          relevanceScore: m.score || m.importance_score || 0.5,
          domain: m.metadata.domain,
          pattern: m.metadata.pattern || [],
          successRate: m.metadata.successRate || 0.5,
        }))
        .sort((a, b) => b.relevanceScore - a.relevanceScore);
    } catch (err) {
      console.error('[DeepResearcher] Blueprint suggestion failed:', err.message);
      return [];
    }
  }
```

- [ ] **Step 2: Wire blueprint pattern into task decomposition**

In `research()`, after the blueprint suggestion block (around line 90) and before `_selectDimensions` (line 145), add blueprint-guided task creation:

```javascript
    // Step 1: Decompose into subtasks
    const stack = new TaskStack();
    const root = stack.createRoot(query);

    // If a high-relevance blueprint was found, use its pattern instead of generic dimensions
    let dimensions;
    if (blueprintUsed) {
      const blueprint = await this._loadBlueprint(blueprintUsed);
      if (blueprint?.pattern?.length > 0) {
        // Use blueprint phases as dimension-like tasks
        for (const phase of blueprint.pattern) {
          const subQuery = (phase.queryTemplate || `${phase.actionType}: ${query}`).replace('{query}', query);
          stack.addSubtask(root.id, subQuery, phase.actionType);
        }
        dimensions = blueprint.pattern.map(p => p.actionType);
        this._emit('research.using_blueprint', { sessionId, blueprintId: blueprintUsed, taskCount: dimensions.length });
      } else {
        dimensions = await this._selectDimensions(query);
        stack.decompose(root.id, dimensions);
      }
    } else {
      dimensions = await this._selectDimensions(query);
      stack.decompose(root.id, dimensions);
    }

    this._emit('research.decomposed', { sessionId, dimensions, taskCount: dimensions.length + 1 });
```

- [ ] **Step 3: Add `_loadBlueprint` helper if it doesn't exist**

Search for `_loadBlueprint` in `researcher.js`. If missing, add:

```javascript
  async _loadBlueprint(blueprintId) {
    try {
      const results = await this.memoryStore.searchMemories({
        query: blueprintId,
        tags: ['blueprint'],
        n_results: 1,
      });
      return results?.[0]?.metadata || null;
    } catch {
      return null;
    }
  }
```

- [ ] **Step 4: Raise the relevance threshold to 0.85**

In `research()` around line 81, change:

```javascript
// From:
if (suggestions.length > 0 && suggestions[0].relevanceScore > 0.6) {
// To:
if (suggestions.length > 0 && suggestions[0].relevanceScore > 0.85) {
```

This prevents low-quality blueprint matches from overriding dimension selection.

- [ ] **Step 5: Commit**

```bash
git add core/src/deep-research/researcher.js
git commit -m "feat(research): blueprint-guided decomposition with 0.85 relevance gate"
```

---

## Task 7: Contradiction Resolution Agent

**Files:**
- Modify: `core/src/deep-research/researcher.js` (add `_resolveContradiction` method, integrate into Phase 5)

- [ ] **Step 1: Add `_resolveContradiction` method**

Add this method after `_actVerify` in `researcher.js`:

```javascript
  /**
   * Resolve a contradiction by searching for a tiebreaker source.
   * Costs: 2 LLM calls + 1 web search per contradiction.
   * Capped at 3 resolutions per session.
   */
  async _resolveContradiction(contradiction, userId, orgId, projectId, sessionId, trailStore) {
    try {
      // 1. Generate targeted tiebreaker search query
      const searchQuery = await this._llm(
        `Two sources disagree:\n` +
        `Claim A (${contradiction.claimA.source}): ${(contradiction.claimA.content || '').slice(0, 300)}\n` +
        `Claim B (${contradiction.claimB.source}): ${(contradiction.claimB.content || '').slice(0, 300)}\n\n` +
        `Write a specific, targeted web search query to find an authoritative tiebreaker source ` +
        `that resolves this disagreement. Return ONLY the search query string, nothing else.`,
        { temperature: 0.3, maxTokens: 200 }
      );

      if (!searchQuery?.trim()) return { resolved: false, reason: 'Empty tiebreaker query' };

      // 2. Search for tiebreaker
      const tiebreaker = await this._actSearchWeb(searchQuery.trim(), userId, orgId, projectId, sessionId, trailStore);
      if (!tiebreaker?.content) {
        contradiction.investigated = true;
        return { resolved: false, reason: 'No tiebreaker source found' };
      }

      // 3. LLM judges which claim the tiebreaker supports
      const verdictRaw = await this._llm(
        `A factual disagreement exists:\n` +
        `Claim A: ${(contradiction.claimA.content || '').slice(0, 300)}\n` +
        `Claim B: ${(contradiction.claimB.content || '').slice(0, 300)}\n\n` +
        `Tiebreaker source says: ${tiebreaker.content.slice(0, 500)}\n\n` +
        `Which claim does the tiebreaker support? Return JSON:\n` +
        `{ "supports": "A" or "B" or "neither", "confidence": 0.0-1.0, "reasoning": "one sentence" }`,
        { temperature: 0.2, maxTokens: 300 }
      );

      const verdict = JSON.parse(verdictRaw);

      // 4. Update contradiction record
      contradiction.unresolved = false;
      contradiction.resolution = {
        supports: verdict.supports,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
        tiebreakerSource: tiebreaker.source,
        tiebreakerQuery: searchQuery.trim(),
        resolvedAt: new Date().toISOString(),
      };

      this._emit('verifier.contradiction_resolved', {
        sessionId,
        dimension: contradiction.dimension,
        supports: verdict.supports,
        confidence: verdict.confidence,
        reasoning: verdict.reasoning,
      });

      return { resolved: true, ...verdict };
    } catch (err) {
      console.error('[DeepResearcher] Contradiction resolution failed:', err.message);
      return { resolved: false, reason: err.message };
    }
  }
```

- [ ] **Step 2: Integrate into Phase 5 (verification) in `_executeTask`**

Find the Phase 5 block in `_executeTask` (around line 380, the `if (step === 5 && findings.length > 0)` block). After the existing contradiction recording loop, add:

```javascript
        // Resolve contradictions (cap at 3 per session)
        if (verification.contradictions?.length > 0) {
          let resolved = 0;
          for (const contradiction of verification.contradictions) {
            if (resolved >= 3) break;
            await trailStore?.recordContradiction(sessionId, contradiction);
            const resolution = await this._resolveContradiction(
              contradiction, userId, orgId, projectId, sessionId, trailStore
            );
            if (resolution.resolved) {
              resolved++;
              // Update the contradiction in trailStore with resolution
              await trailStore?.recordContradiction(sessionId, contradiction);
            }
          }
          this._emit('verifier.contradictions_summary', {
            sessionId,
            total: verification.contradictions.length,
            resolved,
            unresolved: verification.contradictions.length - resolved,
          });
        }
```

Replace the existing simpler contradiction loop:
```javascript
        // REMOVE THIS:
        if (verification.contradictions?.length > 0) {
          for (const contradiction of verification.contradictions) await trailStore?.recordContradiction(sessionId, contradiction);
        }
```

- [ ] **Step 3: Add frontend event handling for contradiction resolution**

In `DeepResearch.jsx`'s `EventCard` `getContent()` switch, add after the existing `verifier.contradiction` case:

```javascript
      case 'verifier.contradiction_resolved':
        return (
          <div className="flex items-center gap-3 bg-green-50 p-2 rounded-lg border border-green-100">
            <CheckCircle2 size={14} className="text-green-600" />
            <span className="text-xs text-green-700 font-medium">
              Contradiction resolved: supports Claim {event.supports} ({(event.confidence * 100).toFixed(0)}% confidence)
            </span>
          </div>
        );
      case 'verifier.contradictions_summary':
        return (
          <div className="flex items-center gap-3">
            <Activity size={14} className="text-[#16a34a]" />
            <span className="text-xs text-[#525252]/70">
              Contradictions: {event.resolved} resolved, {event.unresolved} unresolved of {event.total}
            </span>
          </div>
        );
```

- [ ] **Step 4: Commit**

```bash
git add core/src/deep-research/researcher.js frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx
git commit -m "feat(research): contradiction resolution agent with tiebreaker search"
```

---

## Task 8: Memory-First Retrieval

**Files:**
- Modify: `core/src/deep-research/researcher.js` — `_executeTask` method (move memory search before web search)

- [ ] **Step 1: Add memory-first check at the start of `_executeTask`**

In `_executeTask` (around line 275), after the agent state initialization and before the `while (step < maxSteps)` loop, add:

```javascript
    // Memory-first retrieval: check CSI before web search
    let maxExplorationSteps = 3; // Default web exploration steps
    const memoryResult = await this._actSearchMemory(task.query, userId, orgId, projectId);
    if (memoryResult?.content && (memoryResult.confidence || 0.5) > 0.80) {
      const finding = {
        id: randomUUID(),
        type: 'memory',
        title: memoryResult.title || `Memory: ${task.query.slice(0, 50)}`,
        content: memoryResult.content,
        source: 'hivemind_memory',
        sourceId: memoryResult.sourceId,
        confidence: memoryResult.confidence || 0.8,
        taskQuery: task.query,
        agent: 'explorer',
      };
      findings.push(finding);
      await this._recordFinding(trailStore, sessionId, stepIndex++, 'explorer', 'SEARCH_MEMORY', finding, projectId, {
        thought: `Found high-confidence memory match — using as foundation, reducing web exploration`,
        why: 'Memory-first retrieval: existing knowledge compounds across research sessions',
      });
      this._emit('memory.cache_hit', {
        taskId: task.id,
        title: memoryResult.title,
        confidence: memoryResult.confidence,
      });
      maxExplorationSteps = 2; // Reduce web steps since we have memory context
    }
```

- [ ] **Step 2: Use `maxExplorationSteps` in the exploration phase**

In the `while (step < maxSteps)` loop, change the Phase 1-3 condition (around line 294):

```javascript
      // PHASE 1-3: EXPLORATION (Explorer Agent)
      // Use maxExplorationSteps instead of hardcoded 3
      if (step <= maxExplorationSteps) {
```

- [ ] **Step 3: Enhance `_actSearchMemory` to search cross-project**

Find `_actSearchMemory` (around line 415). Update to search across all user projects, not just the current one:

```javascript
  async _actSearchMemory(query, userId, orgId, projectId) {
    try {
      // Search current project first (most relevant)
      const projectResults = await this.recallFn(query, userId, orgId, {
        project: projectId,
        n_results: 5,
      });

      // Also search globally across all projects for compounding intelligence
      const globalResults = await this.recallFn(query, userId, orgId, {
        n_results: 10,
      });

      // Merge, deduplicate by ID, prefer project-specific results
      const seen = new Set();
      const merged = [];
      for (const r of [...(projectResults || []), ...(globalResults || [])]) {
        const id = r.id || r.sourceId;
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        // Apply recency penalty: findings older than 30 days lose confidence
        const age = (Date.now() - new Date(r.created_at || 0).getTime()) / (1000 * 60 * 60 * 24);
        const recencyFactor = age > 30 ? Math.max(0.5, 1 - (age - 30) / 365) : 1;
        merged.push({ ...r, confidence: (r.confidence || r.importance_score || 0.5) * recencyFactor });
      }

      if (merged.length === 0) return null;

      // Return highest-confidence match
      merged.sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
      const best = merged[0];
      return {
        content: best.content,
        title: best.title,
        sourceId: best.id,
        confidence: best.confidence,
      };
    } catch (err) {
      console.error('[DeepResearcher] Memory search failed:', err.message);
      return null;
    }
  }
```

- [ ] **Step 4: Add frontend event for memory cache hits**

In `DeepResearch.jsx`'s `EventCard` `getContent()` switch:

```javascript
      case 'memory.cache_hit':
        return (
          <div className="flex items-center gap-3 bg-[#9333ea]/5 p-2 rounded-lg border border-[#9333ea]/20">
            <Brain size={14} className="text-[#9333ea]" />
            <span className="text-xs text-[#9333ea] font-medium">
              Memory hit: {event.title?.slice(0, 60)} ({(event.confidence * 100).toFixed(0)}%)
            </span>
          </div>
        );
```

- [ ] **Step 5: Commit**

```bash
git add core/src/deep-research/researcher.js frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx
git commit -m "feat(research): memory-first retrieval with cross-project search and recency decay"
```

---

## Task 9: Confidence-Adaptive Depth

**Files:**
- Modify: `core/src/deep-research/researcher.js` — add adaptive depth logic between waves

- [ ] **Step 1: Add `_shouldContinueResearch` method**

Add this method to `DeepResearcher`:

```javascript
  /**
   * Decide whether to continue research based on current confidence.
   * @param {Array} findings - all findings so far
   * @param {number} currentWave - which wave just completed (1, 2, or 3)
   * @param {TaskStack} stack
   * @returns {{ continue: boolean, reason: string, maxDepth?: number, widen?: boolean }}
   */
  _shouldContinueResearch(findings, currentWave, stack) {
    if (findings.length === 0) return { continue: true, reason: 'no_findings' };

    const avgConfidence = findings.reduce((sum, f) => sum + (f.confidence || 0), 0) / findings.length;
    const contradictions = findings.filter(f => f.type === 'contradiction');

    // High confidence after wave 1 → skip wave 2 contextual dimensions, go straight to gaps
    if (avgConfidence > 0.90 && contradictions.length === 0 && currentWave === 1) {
      this._emit('research.depth_decision', {
        currentWave,
        avgConfidence,
        decision: 'high_confidence_early_stop',
        skippedWave: 2,
      });
      return { continue: false, reason: 'high_confidence_early_stop', skipToGaps: true };
    }

    // Low confidence after wave 2 → extend depth and widen search
    if (avgConfidence < 0.65 && currentWave === 2) {
      this._emit('research.depth_decision', {
        currentWave,
        avgConfidence,
        decision: 'low_confidence_extension',
        newMaxDepth: 6,
      });
      stack.maxDepth = 6;
      return { continue: true, reason: 'low_confidence_extension', widen: true };
    }

    return { continue: true, reason: 'normal' };
  }
```

- [ ] **Step 2: Integrate into wave execution loop**

In the wave execution code added in Task 5, after each wave completes (after `research.wave_completed` emit), add:

```javascript
      // Adaptive depth check after each wave
      if (waveNum < 3) {
        const depthDecision = this._shouldContinueResearch(allFindings, waveNum, stack);

        if (!depthDecision.continue && depthDecision.skipToGaps) {
          // Skip remaining waves, jump to gaps
          this._emit('research.skipping_waves', { sessionId, reason: depthDecision.reason });
          // Only process wave 3 (gaps)
          const gapTasks = waves[3] || [];
          for (const task of gapTasks) {
            this._emit('task.started', { sessionId, taskId: task.id, query: task.query, dimension: task.dimension, progress: stack.getProgress() });
            try {
              const result = await this._executeTask(task, userId, orgId, projectId, sessionId, trailStore);
              stack.complete(task.id, { findings: result.findings, confidence: result.confidence, gaps: result.gaps });
              allFindings.push(...result.findings);
              allSources.push(...(result.sources || []));
              for (const finding of result.findings) await this._saveFindingToCSI(finding, userId, orgId, projectId);
              this._emit('task.completed', { sessionId, taskId: task.id, findingCount: result.findings.length, confidence: result.confidence, progress: stack.getProgress() });
            } catch (err) {
              stack.fail(task.id, err.message);
              this._emit('task.failed', { sessionId, taskId: task.id, error: err.message });
            }
          }
          break; // Exit the wave loop
        }
      }
```

- [ ] **Step 3: Add frontend event handling**

In `DeepResearch.jsx`'s `EventCard` `getContent()` switch:

```javascript
      case 'research.depth_decision':
        return (
          <div className="flex items-center gap-3">
            <Activity size={14} className={event.decision === 'high_confidence_early_stop' ? 'text-[#16a34a]' : 'text-[#d97706]'} />
            <span className="text-xs text-[#525252]/70">
              {event.decision === 'high_confidence_early_stop'
                ? `High confidence (${(event.avgConfidence * 100).toFixed(0)}%) — skipping to synthesis`
                : `Low confidence (${(event.avgConfidence * 100).toFixed(0)}%) — extending search depth to ${event.newMaxDepth}`}
            </span>
          </div>
        );
      case 'research.skipping_waves':
        return (
          <div className="flex items-center gap-3">
            <Zap size={14} className="text-[#16a34a]" />
            <span className="text-xs text-[#16a34a]">Confidence sufficient — fast-tracking to gap analysis</span>
          </div>
        );
```

- [ ] **Step 4: Cap total LLM calls per session**

In `_llm()` method, add a session-level counter. In the `DeepResearcher` constructor:

```javascript
    this._llmCallCount = 0;
    this._maxLlmCalls = 40;
```

At the top of `_llm()`:

```javascript
  async _llm(prompt, { temperature = 0.5, maxTokens = 2000 } = {}) {
    if (this._llmCallCount >= this._maxLlmCalls) {
      console.warn('[DeepResearcher] LLM call limit reached:', this._llmCallCount);
      return '{"action":"FINISH","thought":"LLM call budget exhausted"}';
    }
    this._llmCallCount++;
    // ... rest of method
```

- [ ] **Step 5: Commit**

```bash
git add core/src/deep-research/researcher.js frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx
git commit -m "feat(research): confidence-adaptive depth with early stop and extension"
```

---

## Task 10: Final Integration Test

- [ ] **Step 1: Run a full research session end-to-end**

```bash
# Start research
curl -X POST https://api.hivemind.davinciai.eu/api/research/start \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"query": "What are the latest advances in quantum computing?"}'
```

- [ ] **Step 2: Verify SSE streaming works**

```bash
curl -N https://api.hivemind.davinciai.eu/api/research/$SESSION_ID/stream \
  -H "Authorization: Bearer $API_KEY"
# Expected: real-time events including wave_started, wave_completed, task events
```

- [ ] **Step 3: Verify parallel execution in logs**

Check server logs for overlapping task timestamps:

```bash
docker logs hm-core --tail 100 2>&1 | grep -E 'wave|parallel|task\.(started|completed)'
# Expected: Multiple task.started events with same timestamp in wave 1
```

- [ ] **Step 4: Verify graph shows all layers after completion**

```bash
curl https://api.hivemind.davinciai.eu/api/research/$SESSION_ID/graph \
  -H "Authorization: Bearer $API_KEY" | jq '.layers | keys, (.layers | map_values(length))'
# Expected: sources, claims, trails, observations, executionEvents all populated
```

- [ ] **Step 5: Commit all remaining changes**

```bash
git add -A
git commit -m "feat(research): Deep Research v3 engine upgrades complete

- SSE streaming replaces polling
- Parallel wave execution (2-3x faster)
- Blueprint-guided decomposition
- Contradiction resolution agent
- Memory-first retrieval with cross-project search
- Confidence-adaptive depth"
```

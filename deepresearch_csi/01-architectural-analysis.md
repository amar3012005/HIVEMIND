# Deep Research Component Architecture Refactoring
## Analysis & Proposed Decomposition Strategy

**Date:** April 10, 2026  
**Status:** Architectural Analysis  
**Scope:** Refactoring monolithic DeepResearch.jsx into component-based architecture  
**Reference Model:** 3d-force-graph (https://github.com/vasturiano/3d-force-graph.git)

---

## Executive Summary

The current DeepResearch.jsx is a **monolithic 2056-line component** that handles:
- Real-time event streaming (SSE + polling)
- Graph visualization and layer management
- Multi-tab panel UI (status, report, graph)
- Session management
- State coordination across 8+ independent feature areas

**Problem:** All state, rendering, and business logic live in one component. This causes:
1. **Timeline visibility issue** - Complex event flow through single component makes debugging impossible
2. **Reusability issues** - Cannot reuse graph logic elsewhere (e.g., in MemoryGraph)
3. **Testability issues** - 2056 lines cannot be unit-tested effectively
4. **Performance issues** - All state changes cause full re-renders
5. **Maintainability debt** - Adding features requires understanding entire system

**Solution:** Decompose into **5 specialized, independently-renderable components** following the 3d-force-graph architecture model.

---

## Part 1: Current Monolithic Architecture

### State Breakdown (11 independent feature areas)

```
DeepResearch.jsx (2056 lines)
├── Session Management (6 state vars)
│   ├── sessionId, projectId
│   ├── query, status (idle|running|completed|failed)
│   └── showSessions, isSessionExpanded
│
├── Event Streaming (4 state vars)
│   ├── events[], trailSteps[]
│   ├── agentStates, subgoals
│   └── activeGoal
│
├── Graph Visualization (7 state vars)
│   ├── graphData { nodes[], links[] }
│   ├── graphLayers { sources, claims, trails, observations, executionEvents, blueprints }
│   ├── graphLoading, webUsage
│   ├── selectedNode, graphRefreshKey
│   └── Detached window: isGraphDetached, showGraphWindow, detachedGraphPos, isDraggingGraph, isResizingGraph
│
├── Results Panel (5 state vars)
│   ├── report, findings, durationMs, confidence, fromCache
│   ├── error, showPanel, panelTab, panelSize
│   └── panelRef, panelDragControls
│
└── Complex Coordination
    ├── 8+ useEffect hooks (200+ lines)
    ├── 6+ event handlers
    ├── Custom rendering logic (nodeCanvasObject)
    └── Mixed business logic (graph transformation, markdown rendering)
```

### Problems with Current Approach

#### 1. **State Coupling**
- `sessionId` changes → triggers SSE setup → which fetches graph → which updates `graphData`
- Cannot test one without the other
- Example: `useEffect([sessionId])` calls `fetchGraphData()` which updates `graphData` → causes re-renders → calls `nodeCanvasObject` callback

#### 2. **Render Bloat**
- Any state change re-renders entire 2056-line component
- `ForceGraph2D` is inside JSX, so graph is destroyed/recreated on every parent render
- Custom `nodeCanvasObject` function regenerated on every render

#### 3. **Timeline Visibility Issue (Root Cause)**
- Events flow: SSE → `EventCard` → must scroll down → BUT scroll depends on `panelTab`
- When `panelTab` switches (status → graph), events are not visible
- Graph tab doesn't auto-scroll to show new events
- Event appending logic mixes with graph layer updates
- Hard to trace: where do events come from? Are they being dropped?

#### 4. **Testability Issues**
- Cannot test graph transformation in isolation (lines 464-605)
- Cannot test event processing separately (lines 740-850)
- Cannot test graph rendering without full component setup
- Must mock entire SSE, polling, and API layer to test one feature

#### 5. **Reusability**
- Graph visualization logic is locked inside DeepResearch.jsx
- MemoryGraph page would need to duplicate this logic
- Future features (e.g., collaborative viewing) require the same graph

---

## Part 2: 3d-force-graph Architecture Model

### Key Design Principles

The 3d-force-graph library demonstrates a **component-based architecture** with these patterns:

#### 1. **Separation of Concerns**
```javascript
// 3d-force-graph structure:
src/
├── 3d-force-graph.js       // Main orchestrator (thin layer)
├── index.d.ts              // TypeScript interface (chaining API)
└── kapsule-link.js         // Utility for plugin composition

// Chainable API pattern:
graph
  .graphData(data)
  .nodeColor(d => d.color)
  .onNodeClick(callback)
  .cameraPosition({x, y, z})
```

**Key insight:** The library exposes a **chainable configuration API**, not imperative methods. Configuration is separate from rendering.

#### 2. **Declarative Configuration**
- Graph behavior defined via method chains, not internal state
- Example: `.graphData()` is both getter and setter
- Example: `.nodeLabel(accessor)` receives a pure function, not state

#### 3. **Pluggable Rendering**
- `nodeCanvasObject` is a callback function passed in, not defined inside
- `onNodeClick`, `onNodeHover`, etc. are event callbacks, not internal state mutations
- Rendering is **reactive** to data changes, not to UI state

#### 4. **Encapsulation via Constructor**
```typescript
// TypeScript interface pattern from 3d-force-graph
interface ForceGraph3DGenericInstance<ChainableInstance, N, L> {
  // Public API only
  graphData(): GraphData;
  graphData(data: GraphData): ChainableInstance;
  
  onNodeClick(callback: (node: N) => void): ChainableInstance;
  // ... etc
  
  // Internal state hidden
  // (no public access to _simulation, _nodes, _links)
}
```

**Key insight:** All public methods return `this` for chaining. Internal state is private.

---

## Part 3: Proposed Component Decomposition

### New Architecture (5 Components)

```
DeepResearch (page container, thin orchestrator)
├── ResearchInput (search bar)
├── ResearchPanel (sliding panel with 3 tabs)
│   ├── StatusTab (timeline + event cards)
│   ├── ReportTab (synthesis results)
│   └── GraphTab (graph visualization)
│       └── GraphVisualization (reusable graph component)
└── GraphWindow (detached floating graph)
    └── GraphVisualization (reusable graph component)
```

### Component: 1️⃣ **ResearchInput** (~150 lines)

**Responsibility:** Query input and session management

```javascript
// Props
{
  onSubmit: (query: string) => void,
  onLoadSession: (sessionId: string) => void,
  isLoading: boolean,
  sessions: SessionSummary[],
  error?: string,
}

// State (local only)
query, showSessions, isSessionExpanded

// No knowledge of: graph, events, streaming
```

**File:** `ResearchInput.jsx`

---

### Component: 2️⃣ **StatusTab** (~300 lines)

**Responsibility:** Timeline display and event processing

```javascript
// Props
{
  events: Event[],
  sessionId: string,
  isLive: boolean,
  trailSteps: TrailStep[],
  agentStates: AgentState,
}

// State (local only)
scrollAutomatic

// Handles:
// - EventCard rendering for all event types
// - Timeline auto-scroll
// - Agent status display
// - Trail step visualization

// PURE: Given events[], always renders same output
```

**File:** `StatusTab.jsx`

**Key improvement:** Events are passed as props. StatusTab doesn't fetch, doesn't manage SSE. It's a pure timeline renderer.

---

### Component: 3️⃣ **ReportTab** (~200 lines)

**Responsibility:** Synthesis results display

```javascript
// Props
{
  report: string,
  findings: Finding[],
  confidence: number,
  durationMs: number,
  fromCache: boolean,
  sessionId: string,
  onSaveToMemory: (source) => void,
  isSaving: boolean,
}

// State (local only)
showSaveModal

// Handles:
// - Markdown rendering
// - Finding cards
// - Save to memory buttons
// - Statistics display

// PURE: Given report + findings, always renders same output
```

**File:** `ReportTab.jsx`

---

### Component: 4️⃣ **GraphVisualization** (~400 lines, REUSABLE)

**Responsibility:** Graph rendering and layer management

```javascript
// Props (DECLARATIVE, like 3d-force-graph API)
{
  data: { nodes: Node[], links: Link[] },
  layers: { sources: bool, claims: bool, ... },
  onLayerChange: (layers) => void,
  
  // Rendering customization
  nodeCanvasObject?: (node, ctx, globalScale) => void,
  nodeLabel?: (node) => string,
  linkColor?: (link) => string,
  
  // Event callbacks
  onNodeClick?: (node) => void,
  onNodeHover?: (node) => void,
  
  // Display options
  width: number,
  height: number,
  isLoading?: boolean,
}

// State (visualization only)
zoomLevel, panX, panY, hoveredNode, selectedNode

// Handles:
// - Graph rendering with ForceGraph2D
// - Layer toggle buttons
// - Node rendering with custom canvas
// - Link visualization
// - Zoom/pan controls

// PURE RENDERING: Given same props, renders same graph
```

**File:** `GraphVisualization.jsx`

**Key benefit:** This component can be reused in MemoryGraph, Tara session graphs, etc.

---

### Component: 5️⃣ **ResearchPanel** (~400 lines)

**Responsibility:** Tab management and data orchestration

```javascript
// Props
{
  sessionId?: string,
  status: 'idle' | 'running' | 'completed' | 'failed',
  
  // Tab data
  events: Event[],
  report?: string,
  findings: Finding[],
  graphData: { nodes, links },
  graphLayers: LayerConfig,
  
  // API handlers
  onRefreshGraph: () => void,
  onLayerChange: (layers) => void,
  onSaveToMemory: (source) => void,
  
  // Display
  isOpen: boolean,
  onClose: () => void,
}

// State (local only)
activeTab, panelSize, isGraphDetached

// Handles:
// - Tab switching (Status → Report → Graph)
// - Panel resize/drag
// - Graph detach/reattach
// - Coordination between StatusTab, ReportTab, GraphVisualization
```

**File:** `ResearchPanel.jsx`

---

### Component: 6️⃣ **DeepResearch** (Orchestrator, ~300 lines)

**Responsibility:** Session management, SSE streaming, data fetching, coordination

```javascript
// This becomes the THIN ORCHESTRATOR:
// - Manages sessionId, status
// - Sets up SSE connection and polling
// - Fetches graph data, report, trail steps
// - Calls child components with props

// State
sessionId, projectId, status, error,
events, report, findings, graphData, graphLayers,
agentStates, trailSteps

// Effects
useEffect(sessionId) → setup SSE/polling
useEffect(panelTab) → fetch graph/report on demand
useEffect(events) → update agent states

// Render (simple)
<ResearchInput onSubmit={handleStartResearch} />
<ResearchPanel
  sessionId={sessionId}
  events={events}
  report={report}
  graphData={graphData}
  ... pass all required data as props
/>
```

**Key benefit:** DeepResearch is now just a **data container** that orchestrates child components. It knows about API calls, but not about rendering.

---

## Part 4: Timeline Visibility Issue - How Decomposition Fixes It

### Current Problem Flow

```
User scrolls graph tab
    ↓
panelTab state changes → entire DeepResearch re-renders
    ↓
ForceGraph2D is destroyed/recreated
    ↓
StatusTab is destroyed/recreated (new EventCard instances)
    ↓
New events don't show because they're off-screen when tab switches
    ↓
Users see empty timeline
```

### Fixed Flow with Components

```
User scrolls graph tab
    ↓
panelTab state changes in ResearchPanel (local state)
    ↓
GraphTab mounts, StatusTab unmounts BUT:
  - Events state still in DeepResearch (orchestrator)
  - ResearchPanel still receives events[] as prop
  - When user switches back to status tab:
    - StatusTab re-mounts and receives LATEST events
    - StatusTab renders all events (scroll-independent)
    - New events continue flowing to ResearchPanel
```

**Why it works:** Events are decoupled from graph rendering. StatusTab receives events as props, doesn't depend on graph state.

---

## Part 5: Implementation Roadmap

### Phase 1: Extract Reusable Components (Day 1)

```
1. GraphVisualization.jsx (from DeepResearch.jsx lines 409-1700)
   - Extract all graph-related state
   - Accept data as props
   - Accept callbacks as props
   
2. StatusTab.jsx (from DeepResearch.jsx lines 700-900)
   - Extract timeline + event rendering
   - Accept events[] as prop
   - Make pure functional component
   
3. ReportTab.jsx (from DeepResearch.jsx lines 1400-1520)
   - Extract report display
   - Accept report + findings as props
```

### Phase 2: Decompose Orchestration (Day 1)

```
4. ResearchInput.jsx (from DeepResearch.jsx lines 200-400)
   - Extract search bar
   - Accept handlers as props
   
5. ResearchPanel.jsx (new)
   - Tab container
   - Accepts events, report, graph as props
   - Manages panelTab, panelSize locally
```

### Phase 3: Update DeepResearch Orchestrator (Day 2)

```
6. Simplify DeepResearch.jsx
   - Remove rendering logic (delegate to children)
   - Keep SSE/polling setup
   - Keep state management
   - Keep API calls
   
   New structure:
   <ResearchInput />
   <ResearchPanel {...allProps} />
```

### Phase 4: Verify & Integrate (Day 2)

```
7. Test components independently
8. Verify timeline shows events correctly
9. Deploy and monitor
```

---

## Part 6: Technical Migration Details

### Before: Monolithic
```javascript
// DeepResearch.jsx (2056 lines)
function DeepResearch() {
  // All state
  const [events, setEvents] = useState([]);
  const [graphData, setGraphData] = useState({});
  const [report, setReport] = useState(null);
  const [panelTab, setPanelTab] = useState('status');
  
  // All effects (200+ lines)
  useEffect(() => { /* SSE setup */ }, [sessionId]);
  useEffect(() => { /* fetch graph */ }, [panelTab]);
  
  // All handlers
  const handleStartResearch = async () => { /* 30 lines */ };
  const handleSaveToMemory = async () => { /* 15 lines */ };
  
  // All rendering (1200+ lines of JSX)
  return (
    <div>
      {/* Input UI */}
      {/* Panel UI */}
      {/* Graph */}
    </div>
  );
}
```

### After: Distributed
```javascript
// DeepResearch.jsx (300 lines)
function DeepResearch() {
  // Only session + streaming state
  const [sessionId, setSessionId] = useState(null);
  const [status, setStatus] = useState('idle');
  const [events, setEvents] = useState([]);
  const [graphData, setGraphData] = useState({});
  const [report, setReport] = useState(null);
  
  // Only orchestration effects
  useEffect(() => { /* SSE setup */ }, [sessionId]);
  
  // Delegate rendering
  return (
    <>
      <ResearchInput onSubmit={handleStartResearch} />
      <ResearchPanel
        sessionId={sessionId}
        events={events}
        graphData={graphData}
        report={report}
        onSaveToMemory={handleSaveToMemory}
      />
    </>
  );
}

// StatusTab.jsx (300 lines)
function StatusTab({ events, agentStates }) {
  // PURE: No API calls, no side effects (except scroll)
  return (
    <div className="space-y-2">
      {events.map((event, i) => (
        <EventCard key={i} event={event} />
      ))}
    </div>
  );
}

// GraphVisualization.jsx (400 lines)
function GraphVisualization({ data, layers, onLayerChange }) {
  // PURE graph rendering
  // Can be reused in 5+ places
  return (
    <>
      {/* Layer toggles */}
      {/* ForceGraph2D */}
    </>
  );
}
```

---

## Part 7: Testing Strategy

### Before: Single Monolithic Test
```javascript
describe('DeepResearch', () => {
  it('should display timeline events when research completes', async () => {
    // Must mock: SSE, polling, API, localStorage
    // Must wait for: component mount, SSE setup, event rendering
    // Hard to isolate: is bug in event parsing or rendering?
  });
});
```

### After: Focused Unit Tests
```javascript
describe('StatusTab', () => {
  it('should render events in order', () => {
    render(
      <StatusTab
        events={[
          { type: 'task.reasoning', action: 'SEARCH_WEB' },
          { type: 'source.found', title: 'Example' },
        ]}
      />
    );
    expect(screen.getByText('SEARCH_WEB')).toBeInTheDocument();
    expect(screen.getByText('Example')).toBeInTheDocument();
  });
});

describe('GraphVisualization', () => {
  it('should render nodes and links', () => {
    const { container } = render(
      <GraphVisualization
        data={{
          nodes: [{ id: 'a', title: 'Node A' }],
          links: [{ source: 'a', target: 'b' }],
        }}
      />
    );
    expect(container.querySelector('canvas')).toBeInTheDocument();
  });
});

describe('DeepResearch', () => {
  it('should start research on input submit', async () => {
    // Mock only HTTP, not entire component
    // Much simpler test
  });
});
```

---

## Part 8: Risks & Mitigations

| Risk | Mitigation |
|------|-----------|
| **Props drilling** (pass 10+ props down) | Use context for frequently-passed data (sessionId, userId) |
| **Event flow complexity** | Validate event format at entry point (DeepResearch SSE handler) |
| **Graph component reusability** | Document GraphVisualization API thoroughly in JSDoc |
| **Performance regression** | Use React.memo on StatusTab, ReportTab, GraphVisualization |
| **Breaking changes** | Phase rollout: deploy GraphVisualization reusable first, then refactor DeepResearch |

---

## Part 9: Success Criteria

✅ **Timeline always visible** - events render in StatusTab regardless of graph state  
✅ **GraphVisualization reusable** - can import in MemoryGraph within 1 day  
✅ **Component tests pass** - can unit-test each component independently  
✅ **No performance regression** - graph still renders smoothly with 100+ nodes  
✅ **Code reviews easier** - each component <500 lines (vs 2056)

---

## Part 10: Next Steps

1. **Today:** Analyze component boundaries in detail (see Part 11)
2. **Day 1:** Extract GraphVisualization.jsx as standalone component
3. **Day 1:** Extract StatusTab.jsx and ReportTab.jsx
4. **Day 2:** Refactor DeepResearch.jsx to orchestrator pattern
5. **Day 2:** Deploy and monitor for regressions
6. **Day 3:** Document GraphVisualization API for reusability

---

## Part 11: Detailed Component Boundaries (Line-by-Line)

### GraphVisualization.jsx (Extract from DeepResearch.jsx)

**Source lines:**
- 409-422: graphData, graphLayers, graphLoading, webUsage, selectedNode state → **move to GraphVisualization**
- 464-605: fetchGraphData function → **convert to prop handler**
- 1531-1700: Graph tab JSX → **move to GraphVisualization render**
- Lines 1656-1689: nodeCanvasObject function → **move to GraphVisualization**

**New props needed:**
```typescript
interface GraphVisualizationProps {
  data: { nodes: Node[], links: Link[] };
  layers: LayerConfig;
  isLoading: boolean;
  webUsage?: WebUsage;
  selectedNode?: Node;
  onLayerChange: (layers: LayerConfig) => void;
  onNodeClick: (node: Node) => void;
  onRefresh: () => void;
  width?: number;
  height?: number;
}
```

### StatusTab.jsx (Extract from DeepResearch.jsx)

**Source lines:**
- 78-400: EventCard component → **move to StatusTab**
- 700-850: SSE event handler + rendering → **move EventCard rendering, keep SSE in DeepResearch**
- Lines 857-862: Auto-scroll effect → **move to StatusTab**

**New props needed:**
```typescript
interface StatusTabProps {
  events: Event[];
  sessionId: string;
  isLive: boolean;
  agentStates: AgentState;
  trailSteps: TrailStep[];
  onSaveToMemory: (source: Source) => void;
}
```

---

## References

- **Current Implementation:** `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx` (2056 lines)
- **Reference Architecture:** `/opt/3d-force-graph/src/` (3d-force-graph library structure)
- **Type Definitions:** `/opt/3d-force-graph/src/index.d.ts` (chainable API pattern)


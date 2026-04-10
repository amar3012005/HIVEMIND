# Deep Research Component Refactoring: Visual Architecture

---

## Current Monolithic Architecture (BEFORE)

```
┌─────────────────────────────────────────────────────────────────┐
│                    DeepResearch.jsx (2056 lines)                │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  State (200+ lines)                                              │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ sessionId, projectId, status, error                    │    │
│  │ query, events, report, findings, agentStates          │    │
│  │ graphData, graphLayers, selectedNode, graphLoading     │    │
│  │ webUsage, savingMemories, showPanel, panelTab         │    │
│  │ panelSize, isGraphDetached, showGraphWindow            │    │
│  │ detachedGraphPos, isDraggingGraph, dragOffset          │    │
│  │ isResizingGraph, trailSteps, subgoals, activeGoal      │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Effects (200+ lines)                                            │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ useEffect(sessionId) → SSE setup + polling             │    │
│  │ useEffect(panelTab) → fetch graph/report               │    │
│  │ useEffect(events) → update agent states                │    │
│  │ useEffect(eventsEndRef) → auto-scroll                  │    │
│  │ ... 5 more effects                                      │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Handlers (100+ lines)                                           │
│  ├─ handleStartResearch()        ├─ handleNewResearch()       │
│  ├─ handleSubmit()               ├─ handleLoadSession()       │
│  ├─ handleKeyDown()              ├─ handleSaveToMemory()      │
│  ├─ handleRefreshGraph()         └─ handleDetachGraph()       │
│                                                                  │
│  Rendering (1200+ lines JSX)                                    │
│  ├─ Search bar + input                                         │
│  ├─ Sliding panel with 3 tabs:                                 │
│  │  ├─ Status tab: Events, agent states                        │
│  │  ├─ Report tab: Markdown + findings                         │
│  │  └─ Graph tab: ForceGraph2D + layer toggles                 │
│  └─ Detached graph window                                      │
│                                                                  │
│  PROBLEMS:                                                       │
│  ✗ All state coupled together                                   │
│  ✗ Rendering logic mixed with business logic                   │
│  ✗ Cannot test components independently                        │
│  ✗ Cannot reuse graph logic elsewhere                          │
│  ✗ Cannot debug timeline issues (all mixed)                    │
│  ✗ SSE + graph state coupling causes race conditions           │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

---

## Proposed Component Architecture (AFTER)

```
┌─────────────────────────────────────────────────────────────────┐
│                    DeepResearch.jsx (300 lines)                 │
│                        ORCHESTRATOR ONLY                         │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  State (session + streaming only)                               │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ sessionId, projectId, status, query, error             │    │
│  │ events, report, findings, agentStates                  │    │
│  │ graphData, graphLayers, webUsage                        │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Effects (SSE + data fetching ONLY)                             │
│  ┌────────────────────────────────────────────────────────┐    │
│  │ useEffect(sessionId) → SSE setup + polling             │    │
│  └────────────────────────────────────────────────────────┘    │
│                                                                  │
│  Handlers (orchestration ONLY)                                  │
│  ├─ handleStartResearch()     ├─ handleLoadSession()          │
│  └─ handleSaveToMemory()      └─ handleRefreshGraph()         │
│                                                                  │
│  Rendering (thin orchestration)                                 │
│  └─ <ResearchInput {...props} />                               │
│  └─ <ResearchPanel {...props} />                               │
│                                                                  │
│  BENEFITS:                                                       │
│  ✓ Single responsibility (data coordination)                    │
│  ✓ Easy to understand data flow                                 │
│  ✓ Delegated all rendering to children                         │
│  ✓ No rendering logic = easier to test                         │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
         │                                    │
         ├─────────────────────────┬──────────┤
         │                         │          │
         ▼                         ▼          ▼
    ┌─────────────┐        ┌──────────────┐ ┌─────────────────┐
    │ResearchInput│        │ResearchPanel │ │  GraphWindow    │
    │(150 lines)  │        │(400 lines)   │ │  (150 lines)    │
    ├─────────────┤        ├──────────────┤ ├─────────────────┤
    │ Search bar  │        │ Tab manager  │ │ Detached graph  │
    │ Textarea    │        │ Panel resize │ │ Floating window │
    │ Submit btn  │        │ Local state  │ │ Draggable       │
    │ Sessions UI │        │              │ │ Resizable       │
    └─────────────┘        │Tab 1: Status │ │                 │
         │                 │ ┌─StatusTab─┐│ │ Uses same       │
         │                 │ │(300 lines)││ │GraphVisualization
         │                 │ │Events     ││ │                 │
         │                 │ │Timeline   ││ │                 │
         │                 │ │Auto-scroll││ │                 │
         │                 │ └───────────┘│ └─────────────────┘
         │                 │              │
         │                 │Tab 2: Report │
         │                 │ ┌─ReportTab─┐│
         │                 │ │(200 lines)││
         │                 │ │Markdown   ││
         │                 │ │Findings   ││
         │                 │ │Save btn   ││
         │                 │ └───────────┘│
         │                 │              │
         │                 │Tab 3: Graph  │
         │                 │ ┌──────────────────────┐
         │                 │ │GraphVisualization    │
         │                 │ │(400 lines, REUSABLE!)│
         │                 │ │ Canvas + layers      │
         │                 │ │ Node rendering       │
         │                 │ │ Interaction handlers │
         │                 │ │ Can be used in:      │
         │                 │ │ - MemoryGraph        │
         │                 │ │ - Tara sessions      │
         │                 │ │ - Future features    │
         │                 │ └──────────────────────┘
         │                 │
         │                 └──────────────┘
         │
         └─ Props flow only (no direct coupling)
```

---

## Data Flow Comparison

### BEFORE: Monolithic (Confusing)

```
User clicks "Search"
         │
         ▼
    handleSubmit()  ────────┐
         │                  │ Sets multiple state vars
         ▼                  │
    setStatus('running')    │
    setQuery(q)             │ Triggers multiple
    setSessionId(sid)       │ re-renders
    setShowPanel(true)      │
    setEvents([])           │
         │                  │
         ├─────────────────┘
         │
         ▼
    useEffect triggered (sessionId changed)
         │
         ├──► Event listener (SSE)
         │         │
         │         ├──► Parse event
         │         ├──► setEvents() ──────┐
         │         ├──► setAgentStates()  │ Multiple state updates
         │         │                      │ Multiple re-renders
         │         ▼                      │
         │    ForceGraph2D re-renders    │
         │    EventCard re-renders       │
         │    Report re-renders          │
         │         │                      │
         │         ├─────────────────────┘
         │         │
         │         ▼
         │    nodeCanvasObject() called
         │    with old/new state mix
         │         │
         │         ✗ Race condition!
         │         ✗ Stale closure
         │         ✗ Wrong data renders
         │
         └──► Polling (fallback)
                   │
                   ├──► Fetch status
                   ├──► setEvents() ──────┐
                   ├──► fetchGraphData()  │ Cascade of
                   │                      │ fetches + updates
                   ▼                      │
            setGraphData() ───────────────┘
                   │
                   ▼
            Graph re-renders (destroyed + recreated)
                   │
                   ▼
            Timeline flickers
            Events disappear when user switches tabs
            Graph renders with stale data
```

### AFTER: Component-Based (Clear)

```
User clicks "Search"
         │
         ▼
    handleStartResearch()
    (in DeepResearch orchestrator)
         │
         ├──► setSessionId() ─────┐
         ├──► setStatus()         │ Single flow
         └──► setShowPanel()      │ No mixing
              │                   │
              └─────────────────┬─┘
                                │
                   ┌────────────┴────────────┐
                   │                         │
                   ▼                         ▼
         SSE listener            ResearchPanel props update
         (in DeepResearch)       (receives events, status)
              │                           │
              │                           ├──► ResearchPanel renders
              │                           │    (passes props to tabs)
              ├──► Parse event           │
              │                           ├──► StatusTab renders
              ├──► setEvents()           │    (receives events[])
              │         │                │    (pure function)
              │         ▼                │
              │    DeepResearch          ├──► ReportTab renders
              │    state updates         │    (receives report, findings)
              │         │                │    (pure function)
              │         │                │
              │         └───────────────►├──► GraphVisualization renders
              │                          │    (receives data, layers)
              ▼                          │    (pure function)
         Data updated                    │
         in single source                ▼
         of truth            Clean component hierarchy
              │              No mixing of concerns
              │              Independent rendering
              └─────► All children get latest props
                     All children render independently
                     No state coupling
                     Easy to debug

        ✓ Clear data flow
        ✓ No race conditions
        ✓ Events always visible (regardless of graph state)
        ✓ Graph doesn't interfere with timeline
        ✓ Easy to test each component
```

---

## State Management Comparison

### BEFORE: All in One Component

```javascript
// DeepResearch.jsx
function DeepResearch() {
  // Session (belongs here)
  const [sessionId, setSessionId] = useState(null);
  
  // Events (belongs in DeepResearch)
  const [events, setEvents] = useState([]);
  
  // Graph (should be in GraphVisualization)
  const [graphData, setGraphData] = useState({});
  const [graphLayers, setGraphLayers] = useState({});
  const [selectedNode, setSelectedNode] = useState(null);
  
  // Report (should be in ReportTab)
  const [report, setReport] = useState(null);
  const [findings, setFindings] = useState([]);
  
  // UI (should be in ResearchPanel)
  const [showPanel, setShowPanel] = useState(false);
  const [panelTab, setPanelTab] = useState('status');
  const [panelSize, setPanelSize] = useState('large');
  
  // Graph Window (should be in GraphWindow)
  const [isGraphDetached, setIsGraphDetached] = useState(false);
  const [detachedGraphPos, setDetachedGraphPos] = useState({});
  
  // ... 10 more state vars!
  
  // Problem: One state change triggers multiple re-renders
  // Solution: Distribute state to components that own it
}
```

### AFTER: State Distributed

```javascript
// DeepResearch.jsx (orchestrator)
function DeepResearch() {
  // Only session + streaming state (what this component owns)
  const [sessionId, setSessionId] = useState(null);
  const [status, setStatus] = useState('idle');
  const [events, setEvents] = useState([]);
  const [report, setReport] = useState(null);
  const [graphData, setGraphData] = useState({});
  const [graphLayers, setGraphLayers] = useState({});
  
  // Everything else is in children (they own their local state)
  return (
    <>
      <ResearchInput {...props} />
      <ResearchPanel {...props} />
    </>
  );
}

// ResearchPanel.jsx (owns panel UI state)
function ResearchPanel({ ...dataProps }) {
  const [panelTab, setPanelTab] = useState('status');   // Local
  const [panelSize, setPanelSize] = useState('large');  // Local
  const [isGraphDetached, setIsGraphDetached] = useState(false); // Local
  
  // Receives data as props, manages only its UI
  return (
    <div>
      <StatusTab events={events} /> {/* Pure: just render */}
      <ReportTab report={report} /> {/* Pure: just render */}
      <GraphVisualization data={graphData} /> {/* Pure: just render */}
    </div>
  );
}

// StatusTab.jsx (pure rendering)
function StatusTab({ events, agentStates }) {
  // No state! Just renders what it receives
  return <div>{events.map(e => <EventCard event={e} />)}</div>;
}

// GraphVisualization.jsx (self-contained)
function GraphVisualization({ data, layers, onLayerChange }) {
  const [hoveredNode, setHoveredNode] = useState(null); // Visualization only
  
  // Pure rendering with local visualization state
  return <ForceGraph2D graphData={data} ... />;
}
```

**Benefit:** Each state change is scoped to one component → fewer re-renders → better performance

---

## Timeline Visibility Issue: Root Cause

### Current Problem

```
Timeline empty after user switches tabs

Scenario:
1. User starts research
2. Events start flowing: SSE updates events[]
3. User clicks "Graph" tab → panelTab state changes
4. ENTIRE DeepResearch re-renders (2056 lines!)
5. ForceGraph2D is destroyed and recreated
6. EventCard components are destroyed and recreated
7. Scroll position is lost
8. New events haven't been rendered yet
9. User sees empty timeline

Why it's hard to fix:
- Events flow through SSE handler
- SSE handler updates events[]
- events[] change triggers GraphComponent to update
- GraphComponent and EventCard are siblings in same component
- Hard to trace which state change caused the issue
```

### Fixed with Components

```
Timeline ALWAYS visible (events decoupled from graph)

Scenario:
1. User starts research
2. Events start flowing: SSE updates events[] in DeepResearch
3. StatusTab receives events[] as prop
4. User clicks "Graph" tab → panelTab state changes in ResearchPanel
5. ResearchPanel re-renders (only the panel, not DeepResearch)
6. GraphVisualization mounts
7. StatusTab is hidden but STILL HAS events[] data
8. New events continue flowing to DeepResearch → passed to ResearchPanel
9. When user switches back to Status tab:
   - StatusTab mounts with LATEST events[]
   - Renders all events including new ones
   - Scroll position is fresh

Why it works:
- Events are in DeepResearch (source of truth)
- StatusTab receives events as props (pure function)
- Graph changes don't affect event flow
- Each component owns its local rendering state
```

---

## Testability Comparison

### BEFORE: Monolithic (Hard to Test)

```javascript
describe('DeepResearch', () => {
  it('should display events in timeline', async () => {
    // Mock SSE
    const mockSSE = jest.fn();
    window.EventSource = jest.fn(() => ({
      addEventListener: mockSSE,
      close: jest.fn(),
    }));
    
    // Mock all APIs
    apiClient.controlPlane.post = jest.fn().resolvesWith({
      session_id: '123',
      status: 'running',
    });
    apiClient.controlPlane.get = jest.fn().resolvesWith({
      events: [{ type: 'task.reasoning', action: 'SEARCH_WEB' }],
    });
    
    // Render entire component
    const { getByText } = render(<DeepResearch />);
    
    // Type query
    const input = getByText('Ask anything...');
    fireEvent.change(input, { target: { value: 'test' } });
    
    // Submit
    fireEvent.click(getByText('ArrowUp')); // icon
    
    // Wait for SSE setup
    await waitFor(() => {
      expect(window.EventSource).toHaveBeenCalled();
    });
    
    // Simulate SSE event
    const onmessage = mockSSE.mock.calls[0][1];
    onmessage({ data: JSON.stringify({
      type: 'task.reasoning',
      action: 'SEARCH_WEB',
      thought: 'Searching...'
    }) });
    
    // Now check if event appears
    expect(getByText('Searching...')).toBeInTheDocument();
    
    // PROBLEM: This test is 50+ lines and fragile
    // PROBLEM: Must mock everything (SSE, API, localStorage, window)
    // PROBLEM: If test fails, don't know if it's event handling or rendering
  });
});
```

### AFTER: Components (Easy to Test)

```javascript
describe('StatusTab', () => {
  it('should render events', () => {
    const events = [
      { type: 'task.reasoning', action: 'SEARCH_WEB', thought: 'Searching...' },
    ];
    
    const { getByText } = render(
      <StatusTab events={events} agentStates={{}} />
    );
    
    expect(getByText('Searching...')).toBeInTheDocument();
    
    // BENEFIT: 3 lines, no mocks
    // BENEFIT: Clear what's being tested
    // BENEFIT: Fast (no API, no SSE)
  });
  
  it('should auto-scroll to newest event', async () => {
    const events = [
      { type: 'task.reasoning' },
      { type: 'source.found' },
    ];
    
    const { rerender } = render(
      <StatusTab events={events} agentStates={{}} />
    );
    
    const newEvent = { type: 'claim.found' };
    rerender(
      <StatusTab events={[...events, newEvent]} agentStates={{}} />
    );
    
    // Check scroll happened
    // (implementation-specific assertion)
    
    // BENEFIT: Tests pure rendering logic
  });
});

describe('GraphVisualization', () => {
  it('should render nodes and links', () => {
    const data = {
      nodes: [{ id: 'n1', title: 'Node' }],
      links: [{ source: 'n1', target: 'n2' }],
    };
    
    const { container } = render(
      <GraphVisualization data={data} />
    );
    
    expect(container.querySelector('canvas')).toBeInTheDocument();
    
    // BENEFIT: Pure graph rendering test
  });
});

describe('DeepResearch', () => {
  it('should start research on form submit', async () => {
    // Only test orchestration
    apiClient.controlPlane.post = jest.fn().resolvesWith({
      session_id: '123',
    });
    
    const { getByText } = render(<DeepResearch />);
    fireEvent.change(getByPlaceholder('Ask anything'), { target: { value: 'test' } });
    fireEvent.click(getByRole('button')); // submit
    
    expect(apiClient.controlPlane.post).toHaveBeenCalled();
    
    // BENEFIT: Test orchestration in isolation
  });
});
```

**Testing improvement:** From 50 lines per test → 3-10 lines. From flaky integration tests → unit tests.

---

## Performance Impact

### Rendering Frequency

**BEFORE:**
```
One SSE event arrives
    ↓
events[] state change
    ↓
DeepResearch re-renders (2056 lines)
    ↓
All children destroyed/recreated
    ↓
ForceGraph2D destroyed/recreated (expensive!)
    ↓
Modal destroyed/recreated
    ↓
Average: 1 event = 5-10 component re-renders
```

**AFTER:**
```
One SSE event arrives
    ↓
events[] state change in DeepResearch
    ↓
DeepResearch re-renders (minimal)
    ↓
Only ResearchPanel receives new props
    ↓
StatusTab re-renders (lightweight)
    ↓
GraphVisualization only re-renders if graphData changes
    ↓
Average: 1 event = 1-2 component re-renders

With React.memo:
    ↓
StatusTab only re-renders if events[] changes
    ↓
ReportTab only re-renders if report changes
    ↓
GraphVisualization only re-renders if graphData or layers change
    ↓
Average: 1 event = 1 component re-render (StatusTab only)
```

**Improvement:** 5-10x fewer re-renders = faster rendering, less memory

---

## Bundle Size Impact

```javascript
// BEFORE
DeepResearch.jsx: 2056 lines (65KB)

// AFTER
DeepResearch.jsx:          300 lines (10KB)
GraphVisualization.jsx:    400 lines (13KB)
StatusTab.jsx:             300 lines (10KB)
ReportTab.jsx:             200 lines (7KB)
ResearchInput.jsx:         150 lines (5KB)
ResearchPanel.jsx:         400 lines (13KB)
                          ─────────────────
Total:                    1750 lines (58KB)

Savings: ~7KB (but files are cacheable separately)

Real benefit: Each component can be code-split and tree-shaken
```

---

## Summary: Why This Refactoring Solves the Timeline Issue

| Problem | Root Cause | Solution | Result |
|---------|-----------|----------|--------|
| **Timeline empty after tab switch** | Events and graph state coupled | Events in orchestrator, graph in component | Events always available |
| **SSE streaming interferes with rendering** | SSE updates affect graph re-renders | SSE only updates events[], children render independently | No interference |
| **Scroll position lost** | Timeline component destroyed on re-render | StatusTab only re-renders if events change | Scroll position preserved |
| **Graph doesn't update with new events** | Graph and events in same component | Graph receives graphData prop independently | Graph updates independently |
| **Hard to debug** | 2056 lines mixed logic | 5 focused components, clear data flow | Easy to debug |


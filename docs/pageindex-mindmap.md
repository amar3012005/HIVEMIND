# PageIndex Mind Map - Visual Memory Hierarchy

**Version:** 1.0  
**Created:** 2026-04-07  
**Component:** `PageIndexMindMap.tsx`

---

## Overview

PageIndex Mind Map provides a **visual, interactive representation** of your memory hierarchy as an explorable node graph. Unlike the traditional tree view, the mind map shows relationships spatially with expandable nodes, connection lines, and memory count badges.

## Features

### Visual Layout
- **Radial tree layout** - Root nodes at center, children branch outward
- **Curved connections** - Smooth Bézier curves show parent-child relationships
- **Node sizing** - Larger circles for higher-level nodes (40-80px based on depth)
- **Color coding** - Blue for root/selected, white for regular nodes

### Interactions
| Action | Effect |
|--------|--------|
| **Drag** | Pan the canvas |
| **Scroll** | Zoom in/out (50%-200%) |
| **Click node** | Expand/collapse children |
| **Hover node** | Show tooltip with summary |
| **Double-click** | Select node + show memories |

### UI Controls
- **Zoom buttons** (+/-/reset) - Top right
- **Zoom indicator** - Bottom right (percentage)
- **Node tooltip** - Top left (shows path, memory count, summary)
- **Help hints** - Bottom left (pan/zoom/expand)

## Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                    PageIndexViewer                          │
│  ┌─────────────┐  Toggle  ┌─────────────┐                   │
│  │  Tree View  │ ◄──────► │  Mind Map   │                   │
│  │ (existing)  │          │   (new)     │                   │
│  └─────────────┘          └─────────────┘                   │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
                    ┌─────────────────┐
                    │  PageIndexMind  │
                    │     Map.tsx     │
                    └─────────────────┘
                              │
              ┌───────────────┼───────────────┐
              ▼               ▼               ▼
       SVG Renderer    Layout Engine    Tooltip Panel
       (connections    (computeLayout)  (summary display)
        + nodes)
```

## Layout Algorithm

```typescript
computeLayout() {
  // 1. Start from center (400, 300)
  // 2. For each level:
  //    - Calculate angle for each child
  //    - Place at radius = 120 + level * 40
  //    - Recurse for expanded children
  // 3. Return { nodes, links } for rendering
}
```

**Node sizing:**
- Level 0 (root): 80px
- Level 1: 65px
- Level 2: 50px
- Level 3+: 40px (minimum)

**Spacing:**
- Radius between levels: 120px + level offset
- Angle distribution: 135° arc (−¾π to +¾π)

## Usage

### Basic
```tsx
import { PageIndexViewer } from './hivemind/app/PageIndexViewer';

function MemoryPage() {
  return (
    <PageIndexViewer
      userId={currentUser.id}
      onSelectNode={(node) => {
        console.log('Selected:', node.label);
        // Load memories in this node
      }}
      selectedNodeId={activeNodeId}
    />
  );
}
```

### With Memory Preview
```tsx
function PageIndexWithMemories() {
  const [selectedNode, setSelectedNode] = useState(null);
  const [nodeMemories, setNodeMemories] = useState([]);

  const handleNodeSelect = async (node) => {
    setSelectedNode(node);
    const memories = await apiClient.getPageIndexNodeMemories(node.id);
    setNodeMemories(memories);
  };

  return (
    <div className="flex gap-4">
      <div className="w-1/2 h-[600px]">
        <PageIndexViewer
          userId={userId}
          onSelectNode={handleNodeSelect}
          selectedNodeId={selectedNode?.id}
        />
      </div>
      <div className="w-1/2 overflow-y-auto">
        {nodeMemories.map(mem => (
          <MemoryCard key={mem.id} memory={mem} />
        ))}
      </div>
    </div>
  );
}
```

## API Integration

### Required Endpoints

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/pageindex/tree` | GET | Fetch hierarchy with children |
| `/api/pageindex/node/:id/memories` | GET | Get memories in node |
| `/api/pageindex/memory/:id/move` | POST | Move memory to node |

### Response Format (Tree)
```json
{
  "tree": [
    {
      "id": "uuid",
      "label": "Hivemind",
      "path": "/hivemind/hivemind",
      "depth": 2,
      "memoryCount": 66,
      "memoryIds": ["uuid1", "uuid2"],
      "summary": "LLM-generated summary...",
      "summaryUpdatedAt": "2026-04-07T10:00:00Z",
      "children": [...]
    }
  ]
}
```

## Styling

### Color Palette
```css
--pageindex-root: #117dff;        /* Blue for root/selected */
--pageindex-root-dark: #0d5fcc;   /* Darker blue for stroke */
--pageindex-bg: #fafafa;          /* Light gray canvas */
--pageindex-border: #e3e0db;      /* Border color */
--pageindex-text-primary: #0a0a0a; /* Selected text */
--pageindex-text-secondary: #525252; /* Regular text */
--pageindex-link: #d4d4d4;        /* Connection lines */
```

### Animations
- **Node entrance:** Scale from 0 → 1 over 400ms
- **Link drawing:** pathLength 0 → 1 over 500ms
- **View transition:** Opacity + X-slide over 200ms

## Performance

### Optimizations
1. **Memoized layout** - `computeLayout()` only recalculates on tree/expanded changes
2. **SVG rendering** - Single SVG for all nodes/links (no DOM nodes per element)
3. **Deferred children** - Only render expanded node children
4. **Virtual pan/zoom** - CSS transform, no recalculation

### Limits
- Recommended max: 200 nodes visible simultaneously
- For larger hierarchies: Auto-collapse deep levels

## Accessibility

- **Keyboard navigation** (planned): Arrow keys to traverse, Enter to expand
- **Screen reader labels** (planned): `aria-label` with node info
- **High contrast mode** (planned): Enhanced borders for visibility

## Future Enhancements

### Phase 2
- [ ] Search bar to filter nodes by label
- [ ] Click-and-drag to create new nodes
- [ ] Memory preview on node hover (mini list)
- [ ] Export as PNG/SVG

### Phase 3
- [ ] Force-directed layout option (d3-force)
- [ ] Clustering by topic similarity
- [ ] Timeline view (node creation over time)
- [ ] Collaborative cursors (multi-user view)

## Files

| File | Purpose |
|------|---------|
| `PageIndexMindMap.tsx` | Main mind map component |
| `PageIndexViewer.tsx` | Unified viewer with Tree/Map toggle |
| `PageIndexTree.tsx` | Existing tree view (unchanged) |

## Related Documentation

- [PageIndex Backend API](../core/pageindex-api.md)
- [Memory Ingestion Pipeline](../core/ingestion-pipeline.md)
- [HIVEMIND Memory Graph](memory-graph.md)

---

**Last Updated:** 2026-04-07  
**Maintainer:** Davinci AI Team

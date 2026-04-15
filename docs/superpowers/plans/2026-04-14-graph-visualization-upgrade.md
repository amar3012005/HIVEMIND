# Graph Visualization Upgrade — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Transform the MiroFish graph visualization from raw D3 SVG to a polished, Da-vinci-style canvas-rendered force graph with entity-specific shapes, temporal glow, search with zoom-to-match, layer filters, and an animated node detail sidecar.

**Architecture:** Replace the D3 SVG approach in GraphPanel.vue with canvas-based rendering using the existing D3 force simulation but custom `<canvas>` paint calls. Keep the same data model (nodes/edges from API), same parent integration (GraphPanel props), but completely new rendering and interaction layer.

**Tech Stack:** Vue 3, D3 force simulation (keep), HTML5 Canvas API (new), CSS transitions for UI overlays

**Reference:** `/Users/amar/HIVE-MIND/frontend/Da-vinci/src/components/hivemind/app/pages/MemoryGraph.jsx`

---

## What Da-vinci Does Right (adopt)

1. **Canvas rendering** — paints nodes/links per frame via `nodeCanvasObject`/`linkCanvasObject`. Handles 300+ nodes without SVG DOM bloat.
2. **Shape vocabulary** — circles (default), diamonds (facts/claims), hexagons (agents), stars (insights), rounded squares (observations/sources). Each entity type is instantly recognizable.
3. **Temporal glow** — nodes with recent activity get an outer halo. Decays over time. Communicates freshness at a glance.
4. **Search → zoom** — typing highlights matching nodes (amber ring) and auto-centers the camera on the first match.
5. **Layer filter chips** — one-click to isolate a single entity type. Others dim to 15% opacity.
6. **Colored, confidence-weighted links** — link width = confidence, color = relation type, dashed = derived/low-confidence. Labels appear only at high zoom.
7. **Node detail sidecar** — animated slide-in from right showing: type badge, content, tags, scores (importance/strength/recalls), temporal info, and clickable relationship list that navigates the graph.
8. **Hover tooltip** — lightweight floating card near cursor showing title + type.
9. **Zoom controls** — explicit +/- buttons plus fit-to-view.

## What to Avoid (don't copy)

1. Don't use `react-force-graph-2d` — it's a React lib. Use D3 force simulation + raw Canvas in Vue.
2. Don't copy the team/personal scope toggle — MiroFish is single-simulation scoped.
3. Don't copy the Memory Map / PageIndex modal — not relevant.
4. Don't over-engineer the filter system — MiroFish has a fixed set of entity types (Agent, Source, Claim, Trial, Recall, AgentAction), not dynamic layers.

---

## Task 1: Switch GraphPanel from SVG to Canvas Rendering

**Files:**
- Modify: `frontend/src/components/GraphPanel.vue`

**What changes:**
- Replace `<svg ref="graphSvg">` with `<canvas ref="graphCanvas">`
- Replace all D3 SVG element creation (circles, lines, text) with a `requestAnimationFrame` render loop that paints to canvas
- Keep the D3 force simulation (`d3.forceSimulation`) — just change what it drives (canvas paint instead of SVG attr updates)

**Key code patterns from Da-vinci to adapt:**

```javascript
// Per-frame render
function renderFrame() {
  const ctx = canvas.getContext('2d')
  ctx.clearRect(0, 0, width, height)
  ctx.save()
  ctx.translate(transform.x, transform.y)
  ctx.scale(transform.k, transform.k)
  
  // Paint links first (below nodes)
  links.forEach(link => paintLink(link, ctx, transform.k))
  
  // Paint nodes on top
  nodes.forEach(node => paintNode(node, ctx, transform.k))
  
  ctx.restore()
}
```

- [ ] Step 1: Replace SVG element with Canvas in template
- [ ] Step 2: Create `paintNode(node, ctx, globalScale)` function with shape vocabulary
- [ ] Step 3: Create `paintLink(link, ctx, globalScale)` function with colored/dashed links
- [ ] Step 4: Wire D3 force simulation tick to canvas repaint
- [ ] Step 5: Implement zoom/pan via `d3.zoom()` on the canvas
- [ ] Step 6: Implement hit testing for node click/hover (distance-based, not DOM events)
- [ ] Step 7: Verify existing CSI layer toggle still works
- [ ] Step 8: Commit

---

## Task 2: Entity-Specific Node Shapes

**Files:**
- Modify: `frontend/src/components/GraphPanel.vue` (inside `paintNode`)

**Shape mapping for MiroFish entity types:**

| Entity Type | Shape | Color | Size Modifier |
|-------------|-------|-------|---------------|
| Agent | Hexagon | `#9C27B0` (purple) | 1.2x |
| Source | Rounded square | `#2196F3` (blue) | 0.8x |
| Claim | Diamond | `#7B2D8E` (deep purple) | 1.0x |
| Trial | Star (4-point) | `#FF8A34` (orange) | 1.1x |
| Recall | Circle | `#2196F3` (blue) | 0.7x |
| AgentAction | Small circle | `#607D8B` (grey) | 0.6x |
| Default entity | Circle | from existing color map | 1.0x |

Each shape is drawn via Canvas path API (same pattern as Da-vinci's `paintNode`).

- [ ] Step 1: Define CSI_TYPE_COLORS and CSI_TYPE_SHAPES constants
- [ ] Step 2: Implement hexagon draw (Agent)
- [ ] Step 3: Implement diamond draw (Claim)
- [ ] Step 4: Implement star draw (Trial)
- [ ] Step 5: Implement rounded square draw (Source)
- [ ] Step 6: Apply size modifiers per type
- [ ] Step 7: Commit

---

## Task 3: Temporal Glow + Activity Indicators

**Files:**
- Modify: `frontend/src/components/GraphPanel.vue` (inside `paintNode`)

**Behavior:**
- Nodes with recent CSI actions get an outer glow halo (semi-transparent ring)
- Glow intensity based on recency: full glow within last 30s, fading to 0 over 5 minutes
- Selected node gets a `#117dff` selection ring (2px)
- Search-highlighted nodes get an amber ring

- [ ] Step 1: Compute glow factor per node based on last action timestamp
- [ ] Step 2: Paint outer glow arc before node body
- [ ] Step 3: Paint selection ring for selected node
- [ ] Step 4: Paint highlight ring for search-matched nodes
- [ ] Step 5: Commit

---

## Task 4: Search with Zoom-to-Match

**Files:**
- Modify: `frontend/src/components/GraphPanel.vue`

**Behavior:**
- Search input in the graph toolbar area
- Debounced (300ms) — filters against node name, entity_type, and content
- Matching nodes get amber highlight ring, non-matching dim to 15% opacity
- Camera auto-centers and zooms (3x) to first match
- Match count shown in placeholder: "Search nodes... (N matches)"

- [ ] Step 1: Add search input to template (positioned top-right, above toggles)
- [ ] Step 2: Add `searchQuery`, `searchInput`, `highlightNodes` refs
- [ ] Step 3: Implement debounced search with node matching
- [ ] Step 4: Auto-center camera on first match using `d3.zoom.transform`
- [ ] Step 5: Apply dimming in `paintNode` when `highlightNodes.size > 0`
- [ ] Step 6: Commit

---

## Task 5: Layer Filter Chips

**Files:**
- Modify: `frontend/src/components/GraphPanel.vue`

**Replace** the current toggle switches (Highlight Agents, Edge Labels, CSI Artifacts) with a chip-based filter row matching Da-vinci style:

```
[All] [◆ Claims] [⬡ Agents] [▢ Sources] [⭐ Trials] [● Recalls] [○ Actions]
```

Each chip has a colored dot matching the entity type. Clicking a chip filters to only that type (others dim to 15%). "All" shows everything.

- [ ] Step 1: Define ENTITY_FILTERS array with key, label, icon, color
- [ ] Step 2: Replace toggle-row template with filter chip row
- [ ] Step 3: Add `activeFilter` ref
- [ ] Step 4: Apply filter dimming in `paintNode`
- [ ] Step 5: Remove old toggle CSS
- [ ] Step 6: Commit

---

## Task 6: Colored + Confidence-Weighted Links

**Files:**
- Modify: `frontend/src/components/GraphPanel.vue` (inside `paintLink`)

**Behavior:**
- Link color based on relation type (same mapping as Da-vinci: blue=updates, green=extends, purple=derives)
- Link width = 0.5 + confidence * 2
- Low-confidence links (<0.5) drawn dashed
- Labels shown at midpoint only when zoom > 2.5x (with white background for readability)
- Directional arrows at 90% position

- [ ] Step 1: Define EDGE_COLORS constant for relation types
- [ ] Step 2: Implement `paintLink` with width/color/dash logic
- [ ] Step 3: Add midpoint labels at high zoom
- [ ] Step 4: Add directional arrow painting
- [ ] Step 5: Commit

---

## Task 7: Node Detail Sidecar

**Files:**
- Create: `frontend/src/components/ui/GraphNodeDetail.vue`
- Modify: `frontend/src/components/GraphPanel.vue`

**Behavior:**
- Animated slide-in from right (Vue `<Transition>`) — 340px wide
- Shows: type badge + color dot, entity name, content/bio, properties grid, relationships (inbound/outbound) as clickable buttons that navigate the graph, metadata (ID, created date)
- Close button in sticky header
- Clicking a relationship button centers the graph on that node and opens its detail

- [ ] Step 1: Create GraphNodeDetail.vue component
- [ ] Step 2: Add `selectedNode` ref to GraphPanel
- [ ] Step 3: Render GraphNodeDetail conditionally in GraphPanel template
- [ ] Step 4: Pass graph data to sidecar for relationship resolution
- [ ] Step 5: Implement navigate-to-node callback (center + zoom + select)
- [ ] Step 6: Commit

---

## Task 8: Hover Tooltip

**Files:**
- Modify: `frontend/src/components/GraphPanel.vue`

**Behavior:**
- On node hover, show a lightweight floating tooltip near the cursor
- Shows: entity type icon + name (1 line)
- Positioned 12px right and 12px below cursor
- Disappears immediately on mouse leave

- [ ] Step 1: Add `hoveredNode` and `tooltipPosition` refs
- [ ] Step 2: Update hit-testing to set hoveredNode on hover
- [ ] Step 3: Add tooltip div in template with absolute positioning
- [ ] Step 4: Style tooltip (tiny, no shadow, just bg + border)
- [ ] Step 5: Commit

---

## Task 9: Zoom Controls

**Files:**
- Modify: `frontend/src/components/GraphPanel.vue`

**Behavior:**
- Three buttons pinned bottom-right of graph area: Zoom In (+), Zoom Out (-), Fit to View
- Use `d3.zoom.scaleBy` for +/- and `d3.zoom.transform` for fit-to-view

- [ ] Step 1: Add zoom control buttons in template
- [ ] Step 2: Wire to d3.zoom transform methods
- [ ] Step 3: Style as small rounded buttons
- [ ] Step 4: Commit

---

## Task 10: Browser Testing + Polish

- [ ] Step 1: Start dev server, open simulation with graph data
- [ ] Step 2: Verify canvas renders nodes with correct shapes
- [ ] Step 3: Verify zoom/pan works smoothly
- [ ] Step 4: Verify search highlights and auto-centers
- [ ] Step 5: Verify filter chips isolate entity types
- [ ] Step 6: Verify node click opens sidecar with correct data
- [ ] Step 7: Verify hover tooltip appears and disappears cleanly
- [ ] Step 8: Verify CSI artifact panel still works alongside new graph
- [ ] Step 9: Commit any fixes

---

## File Map Summary

| File | Action | Purpose |
|------|--------|---------|
| `frontend/src/components/GraphPanel.vue` | Major rewrite | SVG → Canvas, shapes, glow, search, filters, zoom |
| `frontend/src/components/ui/GraphNodeDetail.vue` | Create | Animated node detail sidecar |

# HIVEMIND Memory Graph: "My Second Brain, Visualized"

> **Design Vision Document**
> The Memory Graph is not a feature — it's the identity of HIVEMIND.
> This document defines the high-level vision, design principles, competitive analysis (including MiroFish), and the target experience.

---

## The Vision

When a user opens HIVEMIND's Memory Graph, they should feel like they're looking at their own neural network. Not a chart. Not a dashboard. A **living, breathing visualization of everything they know** — connections forming in real time, clusters emerging around topics, old memories fading while new ones glow with energy.

**The 3-second test:** A CTO walks into a demo. The Memory Graph opens. Within 3 seconds, they say "show me more." That's the bar.

**The retention hook:** Individual users come back daily — not because they need to search something, but because they want to **watch their second brain grow**. A new Gmail thread appeared overnight. It's already connected to last week's Slack discussion and the Notion doc from January. That's magic.

---

## Design Principles

### 1. Organic, Not Mechanical
The graph should feel alive — like a neural network or a constellation, not a flowchart. Nodes breathe (subtle pulse animation). Edges have gentle curves, not rigid straight lines. The layout is physics-driven, not grid-based. Clusters form naturally around related topics.

### 2. Calm Density
Dense graphs are a feature, not a problem. A brain with 500 nodes should look impressive and navigable, not overwhelming. Use progressive disclosure: zoomed out shows topology and clusters; zoomed in reveals individual memories with labels and details.

### 3. Temporal Energy
Recent memories glow brighter. Old memories dim but remain connected — they're still part of the brain, just less active. When a memory gets recalled or updated, it briefly pulses, showing the brain is working. This creates a sense of **liveness**.

### 4. Connection-First
The value isn't in individual nodes — it's in the connections between them. Triple operator edges (Updates, Extends, Derives, Contradicts) should be visually distinct and meaningful. A user should be able to trace how an idea evolved just by following the edges.

### 5. Zero Learning Curve
No tutorials needed. The graph should be immediately intuitive. Click a node to see details. Drag to explore. Search to find. Toggle scope to see your team. Everything else is discoverable.

---

## Current State Analysis

### What We Have (MemoryGraph.jsx — 692 lines)

| Aspect | Current Implementation |
|--------|----------------------|
| **Library** | `react-force-graph-2d` (D3 force simulation) |
| **Rendering** | Custom Canvas2D paint functions |
| **Node shapes** | 5 types: star (TARA insight), hexagon (TARA), diamond (fact), rounded square (observation), circle (default) |
| **Node colors** | Layer-based → User-based (team) → Type-based hierarchy |
| **Edge rendering** | Straight lines, solid or dashed (Derives), color-coded by type |
| **Effects** | Temporal glow, promoted risk halo (red), verified glow (green), selection ring |
| **Interactions** | Click, zoom, pan, search highlight, project filter, scope toggle |
| **Detail panel** | Right sidecar with metadata, scores, relationships, navigation |
| **Scope** | Personal / Team / All |

### What Feels Raw

1. **Edges are straight lines** — No curves, no visual weight variation. Parallel edges between same nodes overlap.
2. **No cluster detection** — Nodes spread uniformly. No visible topic groups.
3. **No ambient animation** — Graph is static between interactions. No breathing, no drift.
4. **Node labels hidden by default** — Have to zoom to 1.8x to see labels. Hard to orient.
5. **No minimap** — Large graphs lose spatial context when zoomed in.
6. **Detail panel is functional but plain** — No visual richness, no relationship timeline.
7. **No onboarding state** — Empty graph for new users shows nothing compelling.
8. **Edge labels missing** — Can't see relationship types without clicking.

---

## Competitive Analysis

### Obsidian Graph View

**What they do well:**
- Beautiful ambient feel — nodes drift gently, colors are muted and calming
- Progressive label reveal on zoom — labels appear smoothly as you zoom in
- Color-coded by folder/tag — instant visual grouping
- Filters panel — toggle node types, orphans, attachments
- Local graph view — focus on one note and its neighbors

**What they lack:**
- No relationship types — all edges are identical
- No temporal weight — old and new nodes look the same
- Static — no animation reflecting activity or recency
- Manual linking only — no automatic connections
- Local-only — no team/shared view

### MiroFish (D3 + Vue)

**What they do well:**
- **Curved parallel edges** — When multiple relationships exist between the same pair of nodes, edges fan out as Bezier curves with distributed curvature. Formula: `offsetRatio = 0.25 + pairTotal * 0.05`. This prevents edge overlap and looks elegant.
- **Self-loop merging** — Self-referential edges (same source and target) are collapsed into a single "Self Relations (N)" arc, with an expandable list showing individual relations. Prevents visual chaos.
- **Edge label backgrounds** — White rectangles behind edge labels at the Bezier midpoint. Simple but dramatically improves readability.
- **Smart drag detection** — 3px movement threshold before restarting the force simulation. Prevents accidental graph jitter when clicking nodes.
- **Live graph growth** — Graph re-renders during knowledge graph construction, showing nodes and edges appearing in real time. Creates a sense of "the brain is building."
- **Temporal edge metadata** — Detail panel shows `valid_at`, `invalid_at`, `expired_at` timestamps on relationships. Tracks truth over time.

**What they lack:**
- SVG-only rendering — Won't scale beyond ~500 nodes (Canvas/WebGL needed)
- No node shape differentiation — All circles, only color varies
- No search or filtering in graph view
- No scope/team concept
- No confidence visualization on edges
- Simple color palette — functional but not beautiful

### Mem.ai

**What they do well:**
- Clean, minimal aesthetic
- Memory timeline view (chronological, not graph)
- Smart grouping by topic

**What they lack:**
- No graph visualization at all
- No relationship types
- No team features

### SuperMemory

**What they do well:**
- Container-based organization
- Entity context tuning per container

**What they lack:**
- No graph visualization
- No visual knowledge mapping

---

## Design Ideas to Adopt

### From MiroFish (High Priority)

| Idea | Why | Adaptation for HIVEMIND |
|------|-----|------------------------|
| **Curved parallel edges** | Multiple Updates/Extends/Derives between same nodes currently overlap | Implement Bezier curve fanning with curvature proportional to edge count |
| **Self-loop visualization** | Memories that reference themselves need clean rendering | Merged arc with expandable detail |
| **Edge label toggle** | Dense graphs get cluttered with labels | Toggle button in toolbar: show/hide relationship type labels |
| **Edge label backgrounds** | Labels on edges are hard to read without contrast | White/dark semi-transparent rect behind edge text at curve midpoint |
| **Smart drag threshold** | Clicking nodes shouldn't jitter the graph | 3px movement detection before simulation restart |
| **Live graph growth** | When memories are being ingested, show them appearing | WebSocket or polling during bulk ingest; new nodes fade in with animation |

### From Obsidian (Medium Priority)

| Idea | Why | Adaptation for HIVEMIND |
|------|-----|------------------------|
| **Ambient node drift** | Graph feels alive, not frozen | Gentle random force perturbation after layout settles |
| **Progressive label reveal** | Clean at overview, detailed at close-up | Opacity transition: 0% at zoom <1.5x, 100% at zoom >2.5x, smooth interpolation between |
| **Local graph mode** | Focus on one memory and its neighborhood | "Focus" button on detail panel: filter to 2-hop neighborhood, dim everything else |
| **Filter panel** | Quick toggle for memory types, sources, date ranges | Collapsible left panel with checkboxes per memoryType, source, nodeLayer |

### Novel Ideas (HIVEMIND-Only)

| Idea | Description |
|------|-------------|
| **Cluster detection** | Run community detection (Louvain or label propagation) on the graph; draw translucent convex hulls around clusters with auto-generated topic labels |
| **Memory pulse** | When a memory is recalled or updated, it briefly pulses (scale animation + brightness flash). Creates sense of "the brain is thinking" |
| **Timeline slider** | Scrub through time to see the graph evolve. Slide to January: only January memories visible. Slide to today: full graph. Watch connections form chronologically |
| **Edge confidence width** | Edge stroke width proportional to relationship confidence. Strong connections are thick, weak ones are thin |
| **Source icon badges** | Tiny source-platform icons (Gmail, Slack, GitHub) on each node. Instant visual indicator of where knowledge came from |
| **Thought trail** | When navigating (clicking node to node), leave a fading trail showing the path you took through the graph. "Your train of thought, visualized" |
| **Empty state: neural growth** | For new users with 0-5 memories: show a beautiful animation of a neural network forming, with a CTA to connect their first source |
| **CSI activity overlay** | Toggle to see what the CSI agents (Faraday/Feynman/Turing) have been doing. Touched nodes glow. Hypotheses shown as dashed connector proposals. Verified actions shown as completed green edges |

---

## Target Visual Language

### Color System

```
Background:       #0a0a0f (near-black with blue undertone)
Node base:        Source-type dependent, muted pastels
Node glow:        Temporal weight → white/cyan glow radius
Edge - Updates:   #3b82f6 (blue), solid, curved
Edge - Extends:   #22c55e (green), solid, curved
Edge - Derives:   #a855f7 (purple), dashed, curved
Edge - Contradicts: #ef4444 (red), dotted
Selection:        #60a5fa (bright blue ring)
Cluster hull:     20% opacity of dominant node color
```

### Node Visual Hierarchy

```
                 ★ TARA Insight (4-point star, orange glow)
                ⬡ TARA Turn (hexagon, purple)
               ◆ Fact (diamond, emerald)
              ▣ Observation (rounded square, amber)
             ● Promoted Risk (circle, red halo pulsing)
            ● Verified (circle, green badge glow)
           ● Memory (circle, type-colored)
```

### Interaction Flow

```
Open Graph → See organic neural network (full brain)
  → Zoom in → Labels appear progressively
    → Click node → Detail sidecar opens, node pulses, connected edges highlight
      → Click relationship → Navigate to connected node (trail left behind)
        → "Focus" button → 2-hop neighborhood isolated, rest dims
          → Search → Matching nodes glow orange, camera pans to cluster
            → Scope toggle → Personal → Team (per-user colors) → All (org brain)
              → Timeline slider → Watch brain evolve through time
```

---

## Technical Approach

### Rendering Strategy

**Keep `react-force-graph-2d` with Canvas** — SVG won't scale (MiroFish's approach fails at 500+ nodes). Canvas2D with custom paint functions is the right call for 300-1000 node graphs. If we ever need 10K+ nodes, upgrade to WebGL via `react-force-graph-3d` or `pixi.js`.

### Key Implementation Areas

1. **Bezier edge rendering** — Replace straight `ctx.lineTo()` with `ctx.quadraticCurveTo()`. Calculate control point offset based on parallel edge count between same node pair.

2. **Cluster detection** — Run Louvain community detection on the adjacency matrix client-side (small graph, <1000 nodes). Draw convex hull with `ctx.globalAlpha = 0.08` fill.

3. **Ambient animation** — After force simulation cools, apply gentle sinusoidal perturbation to node positions: `x += Math.sin(time * 0.001 + nodeIndex) * 0.3`.

4. **Progressive labels** — In `paintNode()`, calculate label opacity from zoom level: `opacity = clamp((zoom - 1.5) / 1.0, 0, 1)`.

5. **Timeline slider** — Filter nodes by `createdAt` date range. Animate node opacity (fade in/out) as slider moves. Keep edges visible only when both endpoints are visible.

6. **Source badges** — Draw tiny 6x6 icons at node bottom-right: envelope (email), speech bubble (chat), file (document), code brackets (github).

---

## Success Metrics

| Metric | Target |
|--------|--------|
| **3-second engagement** | CTO says "show me more" in demo within 3 seconds |
| **Daily return rate** | Users open Memory Graph at least once per day |
| **Screenshot sharing** | Users screenshot and share their graph (organic marketing) |
| **Graph load time** | <500ms for 300 nodes with all effects |
| **Interaction responsiveness** | <16ms per frame (60fps) during pan/zoom |
| **Team adoption** | Enterprise teams use Team scope view weekly |

---

## Phase Plan

### Phase 1: Visual Polish (Quick Wins)
- Curved Bezier edges with parallel edge fanning
- Edge label toggle with background rects
- Smart drag threshold (3px)
- Progressive label opacity on zoom
- Edge confidence → stroke width
- Dark neural background (#0a0a0f)

### Phase 2: Living Brain
- Ambient node drift (gentle sinusoidal perturbation)
- Memory pulse on recall/update
- Source icon badges on nodes
- Empty state neural growth animation
- Minimap for spatial context

### Phase 3: Intelligence
- Cluster detection with translucent convex hulls
- Timeline slider (scrub through time)
- Local graph / focus mode (2-hop neighborhood)
- Thought trail (navigation path visualization)
- CSI activity overlay

### Phase 4: Team Experience
- Per-user node coloring with team legend
- Contributor heatmap (who adds most knowledge)
- Cross-team connection highlighting
- Project-scoped sub-graphs

---

## The Differentiator

No one else has this. Obsidian is manual and local. MiroFish is research-grade but basic visually. Mem.ai has no graph at all. Notion is a spreadsheet.

**HIVEMIND's Memory Graph is the only place where you can watch an AI-powered second brain think, grow, and connect knowledge — automatically, in real time, across your entire digital life.**

That's not a feature. That's a category.

---

*Vision document for HIVEMIND Memory Graph redesign. DaVinci AI, April 2026.*

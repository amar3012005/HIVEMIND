# Agent Roster, Dock & Glassmorphism Overlay — Design Spec

**Date:** 2026-04-14
**Scope:** MiroFish frontend — SimulationView, Step2EnvSetup, AgentMessageDock, new AgentDetailOverlay

---

## Problem

Agent profile cards in the Environment stage disappear when transitioning to Simulation. There is no persistent agent roster across stages, no rich detail popup, and the current AgentMessageDock uses plain initial-circles instead of illustrated character avatars. The sandbox creation experience lacks visual narrative.

## Solution

Lift agent profile state to SimulationView. Introduce three focused components — AgentGrid (Environment cards), AgentDock (persistent floating stack), and AgentDetailOverlay (fullscreen glassmorphism popup). Use pre-made SVG avatars from a dedicated assets folder.

---

## 1. Data Architecture

### State ownership: SimulationView.vue

SimulationView becomes the single source of truth for agent data:

- `agentProfiles: Ref<NormalizedProfile[]>` — populated from `getSimulationProfilesRealtime` during workspace hydration
- `selectedAgentId: Ref<number | null>` — drives the glassmorphism overlay
- `openAgentDetail(id: number): void` — sets selectedAgentId
- `closeAgentDetail(): void` — clears selectedAgentId

### Component tree

```
SimulationView (owns agentProfiles, selectedAgentId)
  |-- Step2EnvSetup (receives profiles via prop)
  |     +-- AgentGrid (responsive cards, SVG avatars, staggered entry)
  |-- Step3Simulation (receives profiles via prop)
  |-- AgentDock (floating overlapping stack, always visible when profiles.length > 0)
  +-- AgentDetailOverlay (fullscreen glassmorphism, driven by selectedAgentId)
```

### Profile normalization

Done once in SimulationView when raw profiles arrive. Each NormalizedProfile includes:

```
{
  id: number
  name: string
  entityType: string
  bio: string
  persona: string
  researchRole: string
  responsibility: string
  evidencePriority: string
  skills: string[]
  worldActions: string[]
  peerActions: string[]
  challengeTargets: string[]
  qualificationScore: number
  avatarPath: string          // e.g. "/src/assets/avatars/Agent_3.svg"
  initials: string            // fallback if SVG fails to load
  roleEmoji: string
}
```

### Avatar mapping

- Folder: `frontend/src/assets/avatars/`
- Naming: `Agent_1.svg`, `Agent_2.svg`, ..., `Agent_N.svg`
- Mapping: `avatarPath = Agent_${index + 1}.svg` — deterministic by array position
- Fallback: if SVG count < profile count, wrap around with modulo: `Agent_${(index % totalAvatars) + 1}.svg`

### Data flow

1. SimulationView hydrates workspace, fetches profiles via existing API
2. Profiles are normalized once, stored in `agentProfiles` ref
3. Passed as props to Step2EnvSetup (for AgentGrid) and AgentDock
4. Both components call `openAgentDetail(id)` on click, which SimulationView handles by setting `selectedAgentId`
5. AgentDetailOverlay reads `selectedAgentId` + `agentProfiles` to render the popup

---

## 2. Environment Stage — Sandbox Animation + Agent Grid

### Sequential animation in Step2EnvSetup

**Phase 1: Sandbox shimmer (1-2s)**
- When `prepareStarted` becomes true, the `sandbox-hero` section shows a skeleton pulse overlay
- Text: "Creating Sandbox..."
- Pure CSS `@keyframes shimmer` on a linear-gradient — no library needed
- Gradient sweeps left-to-right across the hero section

**Phase 2: Transition to "Generating Agents"**
- Shimmer fades out (200ms opacity transition)
- `sandbox-visual` shell updates text from "Provisioning" to "Active"
- Agent grid area appears with `opacity 0 -> 1` (200ms)

**Phase 3: Agent card stagger**
- As profiles arrive from polling, each card enters via Vue `<TransitionGroup>`
- CSS transition: `opacity 0 -> 1` + `translateY(8px) -> translateY(0)`
- Stagger: ~100ms offset per card via `transition-delay` computed from index
- Total settle time for 6 agents: ~800ms

### AgentGrid component

**New file:** `frontend/src/components/ui/AgentGrid.vue`

**Props:**
- `profiles: NormalizedProfile[]`
- `onAgentClick: (id: number) => void`

**Layout:**
- CSS Grid: `grid-template-columns: repeat(auto-fill, minmax(140px, 1fr))`
- Gap: 12px
- Responsive: as drawer width increases, more cards per row automatically

**Card contents (compact):**
- SVG avatar: 48px, centered
- Agent name: truncated to 1 line, 13px, weight 600
- Entity type: 1 line, 11px, muted color
- Qualification score: thin horizontal bar (4px height), colored by score range (green > 0.8, amber > 0.6, red below)

**Interaction:**
- `cursor: pointer` on hover
- Subtle scale `1 -> 1.03` on hover (100ms transition)
- Click calls `onAgentClick(agent.id)`

---

## 3. Agent Dock — Floating Overlapping Stack

### Refactored AgentMessageDock.vue

**Structural changes:**
- Remove: `<Teleport to="body">`
- Remove: dropdown popup (replaced by AgentDetailOverlay)
- Remove: horizontal row layout
- Remove: gradient initial bubbles
- Keep: profile normalization logic (shared with SimulationView or receive normalized)
- Keep: action tracking (`latestActionsByAgent` computed)
- Keep: `roleEmoji` mapping

**Rendered by:** SimulationView, positioned inside the workspace-view container

**Position:** Absolute within `.workspace-view`, bottom-left corner: `position: absolute; bottom: 20px; left: 20px; z-index: 45`

**Visual — overlapping avatar stack:**
- Circular avatars: 40px diameter
- SVG character art fills each circle, `border-radius: 50%; overflow: hidden`
- Overlap: `-12px` negative margin between avatars
- Arranged left-to-right in a horizontal row
- `border: 2px solid #fff` on each to create separation
- Max visible: 6 avatars, then a `+N` pill badge (same 40px circle, solid background, white text)

**Hover behavior:**
- On hover over the dock container: avatars spread apart (margin transitions from `-12px` to `4px`, 200ms ease-out)
- Individual avatar: `scale(1.15)` on hover, 100ms

**Click:** Each avatar calls `openAgentDetail(agent.id)`

**Spawn behavior:**
- Dock hidden when `profiles.length === 0`
- Fades in (`opacity 0 -> 1`, 300ms) when first profile arrives
- Individual avatars enter with the same stagger timing as AgentGrid — they populate in sync during Environment stage
- Once populated, dock stays visible through Simulation and Report stages (owned by SimulationView)

**Active agent indicator:**
- Agents with recent actions (from `latestActionsByAgent`) get a subtle green pulse glow on their border
- CSS `@keyframes pulse` — `box-shadow` animates between `0 0 0 0` and `0 0 0 4px rgba(34,197,94,0.3)`
- Agents without recent actions: static white border, no pulse

---

## 4. Fullscreen Glassmorphism Agent Detail Overlay

### New file: `frontend/src/components/ui/AgentDetailOverlay.vue`

**Props:**
- `agent: NormalizedProfile | null` — the selected agent (null = hidden)
- `onClose: () => void`

**Visibility:** Rendered when `agent` is not null.

### Backdrop

- `position: fixed; inset: 0; z-index: 100`
- `background: rgba(0, 0, 0, 0.4)`
- `backdrop-filter: blur(20px) saturate(1.2)`
- Click on backdrop calls `onClose()`
- `Escape` key calls `onClose()` (keyboard listener)

### Entry/exit animation

- Entry: backdrop fades in (200ms), center card `transform: scale(0.95) -> scale(1)` + `opacity: 0 -> 1` (250ms, `ease-out`)
- Exit: reverse, 150ms
- Use Vue `<Transition>` with named classes

### Center profile card

- `max-width: 480px; width: 90vw` — responsive on small screens
- Centered: `margin: auto` within a flex container (`align-items: center; justify-content: center`)
- Glass material: `background: rgba(255, 255, 255, 0.12); backdrop-filter: blur(24px); border: 1px solid rgba(255, 255, 255, 0.18); border-radius: 24px`
- `box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2)`
- `padding: 32px`
- `overflow-y: auto; max-height: 85vh`

### Card content (top to bottom)

**1. Header**
- SVG avatar: 96px, centered, `border-radius: 50%`
- Agent name: 22px, weight 600, white, centered, below avatar (8px gap)
- Entity type: 14px, `rgba(255,255,255,0.7)`, centered
- Qualification score: thin horizontal bar (6px height, 120px wide), centered below entity type. Color: green (>0.8), amber (>0.6), red (below). Percentage label right-aligned.

**2. Persona**
- `margin-top: 20px`
- Persona text: 14px, `rgba(255,255,255,0.8)`, line-height 1.6
- Max 3-4 lines, no truncation (card scrolls if needed)

**3. Role section**
- `margin-top: 20px`
- Research role: inline badge pill (small, colored by role type)
- Responsibility: 13px text below the badge
- Evidence priority: small tag/chip, muted style

**4. Capabilities grid**
- `margin-top: 20px`
- Two columns (CSS grid, `1fr 1fr`, gap 12px)
- Left column header: "Skills" (11px, uppercase, muted)
  - `skills[]` as small rounded chips (10px, `rgba(255,255,255,0.15)` background, white text)
- Right column header: "Actions" (11px, uppercase, muted)
  - `world_actions[]` + `peer_actions[]` as chips (different tint, e.g. `rgba(99,179,237,0.2)`)

**5. Challenge targets**
- Only shown if `challengeTargets.length > 0`
- `margin-top: 16px`
- Label: "Challenges" (11px, uppercase, muted)
- Target role names as small outlined chips

### Typography

- All text: white / rgba white variants on glass surface
- Name: weight 600
- Body text: weight 400
- Scores, IDs: `'JetBrains Mono', monospace`

---

## 5. Files Changed

| File | Action | Description |
|------|--------|-------------|
| `frontend/src/assets/avatars/` | Create | Folder for SVG avatar files (Agent_1.svg ... Agent_N.svg) |
| `frontend/src/components/ui/AgentGrid.vue` | Create | Responsive agent card grid for Environment stage |
| `frontend/src/components/ui/AgentDetailOverlay.vue` | Create | Fullscreen glassmorphism popup |
| `frontend/src/components/ui/AgentMessageDock.vue` | Refactor | Floating overlapping stack, remove teleport + dropdown |
| `frontend/src/views/SimulationView.vue` | Modify | Lift agent state, render AgentDock + AgentDetailOverlay |
| `frontend/src/components/Step2EnvSetup.vue` | Modify | Add sandbox shimmer animation, replace profile cards with AgentGrid |
| `frontend/src/components/Step3Simulation.vue` | Modify | Accept profiles prop (no visual change) |

---

## 6. What Is NOT In Scope

- No changes to backend APIs — profile data structure stays the same
- No changes to the graph panel or report stages
- No new API calls — using existing `getSimulationProfilesRealtime`
- No sound design or Lottie animations (CSS-only motion)
- No changes to the simulation execution logic
- Creating the actual SVG avatar artwork (assumed pre-existing)

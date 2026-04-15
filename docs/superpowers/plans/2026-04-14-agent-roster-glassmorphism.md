# Agent Roster, Dock & Glassmorphism Overlay — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persistent agent roster with SVG avatars across Environment and Simulation stages, floating overlapping dock, and fullscreen glassmorphism detail overlay.

**Architecture:** Lift agent profile state to SimulationView.vue. Three new/refactored components: AgentGrid (responsive cards in Environment), AgentDock (floating overlapping stack), AgentDetailOverlay (glassmorphism popup). All share normalized profile data from SimulationView via props.

**Tech Stack:** Vue 3 (Composition API), CSS Grid, CSS `backdrop-filter`, Vue `<Transition>` / `<TransitionGroup>`

**Spec:** `docs/superpowers/specs/2026-04-14-agent-roster-glassmorphism-design.md`

---

### Task 1: Create Avatar Assets Folder

**Files:**
- Create: `frontend/src/assets/avatars/` (directory)

This is a placeholder structure. The user will populate SVG files. We create the folder and a single placeholder so imports don't break.

- [ ] **Step 1: Create avatars directory with a placeholder**

```bash
mkdir -p /Users/amar/HIVE-MIND/MiroFish/frontend/src/assets/avatars
```

Create `frontend/src/assets/avatars/.gitkeep` (empty file to track the folder in git).

- [ ] **Step 2: Create the avatar resolver utility**

Create `frontend/src/utils/avatarResolver.js`:

```javascript
const avatarModules = import.meta.glob('../assets/avatars/Agent_*.svg', { eager: true, query: '?url', import: 'default' })

const avatarList = Object.entries(avatarModules)
  .sort(([a], [b]) => {
    const numA = parseInt(a.match(/Agent_(\d+)/)?.[1] || '0', 10)
    const numB = parseInt(b.match(/Agent_(\d+)/)?.[1] || '0', 10)
    return numA - numB
  })
  .map(([, url]) => url)

export const totalAvatars = avatarList.length

export function getAvatarUrl(index) {
  if (avatarList.length === 0) return null
  return avatarList[index % avatarList.length]
}
```

- [ ] **Step 3: Commit**

```bash
git add MiroFish/frontend/src/assets/avatars/.gitkeep MiroFish/frontend/src/utils/avatarResolver.js
git commit -m "feat: add avatar assets folder and resolver utility"
```

---

### Task 2: Create AgentDetailOverlay Component

**Files:**
- Create: `frontend/src/components/ui/AgentDetailOverlay.vue`

- [ ] **Step 1: Create the component file**

Create `frontend/src/components/ui/AgentDetailOverlay.vue`:

```vue
<template>
  <Transition name="overlay">
    <div v-if="agent" class="agent-overlay-backdrop" @click.self="$emit('close')" @keydown.esc="$emit('close')">
      <div class="agent-overlay-card">
        <button class="overlay-close-btn" type="button" @click="$emit('close')">×</button>

        <div class="overlay-header">
          <div class="overlay-avatar-ring">
            <img v-if="agent.avatarPath" :src="agent.avatarPath" :alt="agent.name" class="overlay-avatar-img" />
            <span v-else class="overlay-avatar-fallback">{{ agent.initials }}</span>
          </div>
          <h2 class="overlay-name">{{ agent.name }}</h2>
          <span class="overlay-entity-type">{{ agent.entityType }}</span>
          <div class="overlay-score-bar">
            <div class="score-fill" :style="{ width: `${(agent.qualificationScore || 0) * 100}%`, background: scoreColor }"></div>
          </div>
          <span class="overlay-score-label">{{ ((agent.qualificationScore || 0) * 100).toFixed(0) }}% qualified</span>
        </div>

        <div class="overlay-section">
          <p class="overlay-persona">{{ agent.persona }}</p>
        </div>

        <div class="overlay-section">
          <span class="overlay-role-badge" :style="{ background: roleBadgeColor }">{{ agent.researchRole }}</span>
          <p class="overlay-responsibility">{{ agent.responsibility }}</p>
          <span v-if="agent.evidencePriority" class="overlay-evidence-tag">{{ agent.evidencePriority }}</span>
        </div>

        <div class="overlay-capabilities">
          <div class="cap-column">
            <span class="cap-header">Skills</span>
            <div class="cap-chips">
              <span v-for="skill in agent.skills" :key="skill" class="cap-chip skill-chip">{{ skill }}</span>
            </div>
          </div>
          <div class="cap-column">
            <span class="cap-header">Actions</span>
            <div class="cap-chips">
              <span v-for="action in allActions" :key="action" class="cap-chip action-chip">{{ action }}</span>
            </div>
          </div>
        </div>

        <div v-if="agent.challengeTargets && agent.challengeTargets.length > 0" class="overlay-section">
          <span class="cap-header">Challenges</span>
          <div class="cap-chips">
            <span v-for="target in agent.challengeTargets" :key="target" class="cap-chip challenge-chip">{{ target }}</span>
          </div>
        </div>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, onMounted, onBeforeUnmount } from 'vue'

const props = defineProps({
  agent: {
    type: Object,
    default: null
  }
})

const emit = defineEmits(['close'])

const scoreColor = computed(() => {
  const score = props.agent?.qualificationScore || 0
  if (score > 0.8) return '#22c55e'
  if (score > 0.6) return '#f59e0b'
  return '#ef4444'
})

const roleBadgeColor = computed(() => {
  const role = String(props.agent?.researchRole || '').toLowerCase()
  if (role.includes('explorer')) return 'rgba(59, 130, 246, 0.3)'
  if (role.includes('domain') || role.includes('expert')) return 'rgba(139, 92, 246, 0.3)'
  if (role.includes('fact') || role.includes('check')) return 'rgba(34, 197, 94, 0.3)'
  if (role.includes('challeng')) return 'rgba(239, 68, 68, 0.3)'
  if (role.includes('synth')) return 'rgba(236, 72, 153, 0.3)'
  return 'rgba(255, 255, 255, 0.15)'
})

const allActions = computed(() => [
  ...(props.agent?.worldActions || []),
  ...(props.agent?.peerActions || [])
])

const handleKeydown = (e) => {
  if (e.key === 'Escape' && props.agent) {
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown)
})

onBeforeUnmount(() => {
  document.removeEventListener('keydown', handleKeydown)
})
</script>

<style scoped>
.agent-overlay-backdrop {
  position: fixed;
  inset: 0;
  z-index: 100;
  background: rgba(0, 0, 0, 0.4);
  backdrop-filter: blur(20px) saturate(1.2);
  display: flex;
  align-items: center;
  justify-content: center;
}

.agent-overlay-card {
  position: relative;
  max-width: 480px;
  width: 90vw;
  max-height: 85vh;
  overflow-y: auto;
  padding: 32px;
  border-radius: 24px;
  background: rgba(255, 255, 255, 0.12);
  backdrop-filter: blur(24px);
  border: 1px solid rgba(255, 255, 255, 0.18);
  box-shadow: 0 8px 32px rgba(0, 0, 0, 0.2);
}

.overlay-close-btn {
  position: absolute;
  top: 16px;
  right: 16px;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.1);
  color: rgba(255, 255, 255, 0.6);
  font-size: 18px;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background 0.15s;
}

.overlay-close-btn:hover {
  background: rgba(255, 255, 255, 0.2);
  color: #fff;
}

.overlay-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
}

.overlay-avatar-ring {
  width: 96px;
  height: 96px;
  border-radius: 50%;
  overflow: hidden;
  background: rgba(255, 255, 255, 0.08);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 4px;
}

.overlay-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.overlay-avatar-fallback {
  font-size: 32px;
  font-weight: 700;
  color: rgba(255, 255, 255, 0.5);
}

.overlay-name {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  color: #fff;
}

.overlay-entity-type {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.7);
}

.overlay-score-bar {
  width: 120px;
  height: 6px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.1);
  margin-top: 8px;
  overflow: hidden;
}

.score-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.4s ease;
}

.overlay-score-label {
  font-size: 11px;
  font-family: 'JetBrains Mono', monospace;
  color: rgba(255, 255, 255, 0.5);
  margin-top: 2px;
}

.overlay-section {
  margin-top: 20px;
}

.overlay-persona {
  font-size: 14px;
  color: rgba(255, 255, 255, 0.8);
  line-height: 1.6;
  margin: 0;
}

.overlay-role-badge {
  display: inline-block;
  padding: 4px 10px;
  border-radius: 999px;
  font-size: 11px;
  font-weight: 600;
  color: #fff;
  text-transform: capitalize;
  margin-bottom: 8px;
}

.overlay-responsibility {
  font-size: 13px;
  color: rgba(255, 255, 255, 0.7);
  line-height: 1.5;
  margin: 0 0 8px;
}

.overlay-evidence-tag {
  display: inline-block;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 10px;
  font-family: 'JetBrains Mono', monospace;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(255, 255, 255, 0.5);
  text-transform: lowercase;
}

.overlay-capabilities {
  margin-top: 20px;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.cap-column {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.cap-header {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: rgba(255, 255, 255, 0.4);
}

.cap-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}

.cap-chip {
  padding: 3px 8px;
  border-radius: 6px;
  font-size: 10px;
  font-weight: 500;
  white-space: nowrap;
}

.skill-chip {
  background: rgba(255, 255, 255, 0.15);
  color: rgba(255, 255, 255, 0.85);
}

.action-chip {
  background: rgba(99, 179, 237, 0.2);
  color: rgba(147, 197, 253, 0.9);
}

.challenge-chip {
  background: transparent;
  border: 1px solid rgba(255, 255, 255, 0.2);
  color: rgba(255, 255, 255, 0.6);
}

/* Transitions */
.overlay-enter-active {
  transition: opacity 0.2s ease;
}

.overlay-enter-active .agent-overlay-card {
  transition: transform 0.25s ease-out, opacity 0.25s ease-out;
}

.overlay-leave-active {
  transition: opacity 0.15s ease;
}

.overlay-leave-active .agent-overlay-card {
  transition: transform 0.15s ease-in, opacity 0.15s ease-in;
}

.overlay-enter-from {
  opacity: 0;
}

.overlay-enter-from .agent-overlay-card {
  opacity: 0;
  transform: scale(0.95);
}

.overlay-leave-to {
  opacity: 0;
}

.overlay-leave-to .agent-overlay-card {
  opacity: 0;
  transform: scale(0.95);
}
</style>
```

- [ ] **Step 2: Verify no syntax errors**

```bash
cd /Users/amar/HIVE-MIND/MiroFish/frontend && npx vue-tsc --noEmit 2>&1 | head -20 || echo "OK (no vue-tsc or no tsconfig)"
```

- [ ] **Step 3: Commit**

```bash
git add MiroFish/frontend/src/components/ui/AgentDetailOverlay.vue
git commit -m "feat: add fullscreen glassmorphism AgentDetailOverlay component"
```

---

### Task 3: Create AgentGrid Component

**Files:**
- Create: `frontend/src/components/ui/AgentGrid.vue`

- [ ] **Step 1: Create the component file**

Create `frontend/src/components/ui/AgentGrid.vue`:

```vue
<template>
  <div class="agent-grid-wrapper">
    <TransitionGroup name="agent-card" tag="div" class="agent-grid">
      <button
        v-for="(agent, idx) in profiles"
        :key="agent.id"
        class="agent-grid-card"
        type="button"
        :style="{ transitionDelay: `${idx * 100}ms` }"
        @click="$emit('agent-click', agent.id)"
      >
        <div class="grid-avatar">
          <img v-if="agent.avatarPath" :src="agent.avatarPath" :alt="agent.name" class="grid-avatar-img" />
          <span v-else class="grid-avatar-fallback">{{ agent.initials }}</span>
        </div>
        <span class="grid-agent-name">{{ agent.name }}</span>
        <span class="grid-agent-type">{{ agent.entityType }}</span>
        <div class="grid-score-bar">
          <div
            class="grid-score-fill"
            :style="{
              width: `${(agent.qualificationScore || 0) * 100}%`,
              background: scoreColor(agent.qualificationScore)
            }"
          ></div>
        </div>
      </button>
    </TransitionGroup>
  </div>
</template>

<script setup>
defineProps({
  profiles: {
    type: Array,
    default: () => []
  }
})

defineEmits(['agent-click'])

const scoreColor = (score) => {
  if (score > 0.8) return '#22c55e'
  if (score > 0.6) return '#f59e0b'
  return '#ef4444'
}
</script>

<style scoped>
.agent-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(140px, 1fr));
  gap: 12px;
}

.agent-grid-card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 16px 8px 12px;
  border: 1px solid #e3e0db;
  border-radius: 12px;
  background: #fff;
  cursor: pointer;
  transition: transform 0.1s ease, box-shadow 0.15s ease;
}

.agent-grid-card:hover {
  transform: scale(1.03);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
}

.grid-avatar {
  width: 48px;
  height: 48px;
  border-radius: 50%;
  overflow: hidden;
  background: #f3f1ec;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.grid-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.grid-avatar-fallback {
  font-size: 16px;
  font-weight: 700;
  color: #737373;
}

.grid-agent-name {
  font-size: 13px;
  font-weight: 600;
  color: #0a0a0a;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.grid-agent-type {
  font-size: 11px;
  color: #737373;
  text-align: center;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}

.grid-score-bar {
  width: 80%;
  height: 4px;
  border-radius: 2px;
  background: #f3f1ec;
  overflow: hidden;
  margin-top: 4px;
}

.grid-score-fill {
  height: 100%;
  border-radius: 2px;
  transition: width 0.4s ease;
}

/* TransitionGroup animations */
.agent-card-enter-active {
  transition: opacity 0.3s ease, transform 0.3s ease;
}

.agent-card-leave-active {
  transition: opacity 0.2s ease, transform 0.2s ease;
}

.agent-card-enter-from {
  opacity: 0;
  transform: translateY(8px);
}

.agent-card-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

.agent-card-move {
  transition: transform 0.3s ease;
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add MiroFish/frontend/src/components/ui/AgentGrid.vue
git commit -m "feat: add responsive AgentGrid component with staggered entry"
```

---

### Task 4: Refactor AgentMessageDock to Floating Overlapping Stack

**Files:**
- Modify: `frontend/src/components/ui/AgentMessageDock.vue` (full rewrite)

The dock becomes a compact overlapping avatar stack. It no longer teleports to body or renders dropdowns. It receives normalized profiles via props and emits `agent-click` events.

- [ ] **Step 1: Rewrite AgentMessageDock.vue**

Replace the entire file `frontend/src/components/ui/AgentMessageDock.vue` with:

```vue
<template>
  <Transition name="dock-fade">
    <div v-if="profiles.length > 0" class="agent-dock-float">
      <div
        class="dock-stack"
        @mouseenter="expanded = true"
        @mouseleave="expanded = false"
      >
        <TransitionGroup name="dock-avatar" tag="div" class="dock-avatars" :class="{ expanded }">
          <button
            v-for="(agent, idx) in visibleProfiles"
            :key="agent.id"
            class="dock-avatar-btn"
            :class="{ 'has-activity': hasRecentAction(agent.id) }"
            type="button"
            :style="{ transitionDelay: `${idx * 60}ms` }"
            :aria-label="`View ${agent.name}`"
            @click="$emit('agent-click', agent.id)"
          >
            <img v-if="agent.avatarPath" :src="agent.avatarPath" :alt="agent.name" class="dock-avatar-img" />
            <span v-else class="dock-avatar-initials">{{ agent.initials }}</span>
          </button>
        </TransitionGroup>

        <span v-if="hiddenCount > 0" class="dock-overflow-badge">+{{ hiddenCount }}</span>
      </div>
    </div>
  </Transition>
</template>

<script setup>
import { computed, ref, onMounted, onBeforeUnmount } from 'vue'
import { getSimulationActions } from '../../api/simulation'

const props = defineProps({
  profiles: {
    type: Array,
    default: () => []
  },
  simulationId: {
    type: String,
    default: ''
  },
  maxVisible: {
    type: Number,
    default: 6
  }
})

defineEmits(['agent-click'])

const expanded = ref(false)
const loadedActions = ref([])
let refreshTimer = null

const visibleProfiles = computed(() => props.profiles.slice(0, props.maxVisible))
const hiddenCount = computed(() => Math.max(0, props.profiles.length - props.maxVisible))

const latestActionsByAgent = computed(() => {
  const map = {}
  for (let i = 0; i < loadedActions.value.length; i++) {
    const action = loadedActions.value[i]
    if (!action) continue
    const agentId = action.agent_id
    if (agentId === undefined || agentId === null) continue
    if (!map[agentId]) {
      map[agentId] = action
    }
  }
  return map
})

const hasRecentAction = (agentId) => {
  const action = latestActionsByAgent.value[agentId]
  if (!action) return false
  const ts = action.timestamp || action.created_at
  if (!ts) return false
  return (Date.now() - new Date(ts).getTime()) < 30000
}

const loadActions = async () => {
  if (!props.simulationId) return
  try {
    const res = await getSimulationActions(props.simulationId, { limit: 80 })
    if (res?.success) {
      loadedActions.value = Array.isArray(res.data?.actions) ? res.data.actions : []
    }
  } catch {
    // silently fail
  }
}

const startRefresh = () => {
  if (refreshTimer) clearInterval(refreshTimer)
  refreshTimer = setInterval(loadActions, 3000)
}

const stopRefresh = () => {
  if (refreshTimer) {
    clearInterval(refreshTimer)
    refreshTimer = null
  }
}

onMounted(() => {
  if (props.simulationId) {
    loadActions()
    startRefresh()
  }
})

onBeforeUnmount(() => {
  stopRefresh()
})
</script>

<style scoped>
.agent-dock-float {
  position: absolute;
  bottom: 20px;
  left: 20px;
  z-index: 45;
}

.dock-stack {
  display: flex;
  align-items: center;
  gap: 0;
}

.dock-avatars {
  display: flex;
  align-items: center;
}

.dock-avatar-btn {
  position: relative;
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 2px solid #fff;
  overflow: hidden;
  background: #e3e0db;
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: -12px;
  transition: margin-left 0.2s ease-out, transform 0.1s ease;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.dock-avatar-btn:first-child {
  margin-left: 0;
}

.dock-avatars.expanded .dock-avatar-btn {
  margin-left: 4px;
}

.dock-avatars.expanded .dock-avatar-btn:first-child {
  margin-left: 0;
}

.dock-avatar-btn:hover {
  transform: scale(1.15);
  z-index: 2;
}

.dock-avatar-btn.has-activity {
  animation: agent-pulse 2s ease-in-out infinite;
}

.dock-avatar-img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.dock-avatar-initials {
  font-size: 13px;
  font-weight: 700;
  color: #525252;
  font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Text', system-ui, sans-serif;
}

.dock-overflow-badge {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  border: 2px solid #fff;
  background: #0a0a0a;
  color: #fff;
  font-size: 12px;
  font-weight: 600;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-left: -12px;
  flex-shrink: 0;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

/* Animations */
@keyframes agent-pulse {
  0%, 100% { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1), 0 0 0 0 rgba(34, 197, 94, 0); }
  50% { box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1), 0 0 0 4px rgba(34, 197, 94, 0.3); }
}

.dock-fade-enter-active {
  transition: opacity 0.3s ease;
}

.dock-fade-leave-active {
  transition: opacity 0.2s ease;
}

.dock-fade-enter-from,
.dock-fade-leave-to {
  opacity: 0;
}

.dock-avatar-enter-active {
  transition: opacity 0.25s ease, transform 0.25s ease;
}

.dock-avatar-leave-active {
  transition: opacity 0.15s ease, transform 0.15s ease;
}

.dock-avatar-enter-from {
  opacity: 0;
  transform: scale(0.5);
}

.dock-avatar-leave-to {
  opacity: 0;
  transform: scale(0.5);
}

.dock-avatar-move {
  transition: transform 0.2s ease;
}

/* Mobile */
@media (max-width: 900px) {
  .agent-dock-float {
    bottom: 12px;
    left: 12px;
  }
}
</style>
```

- [ ] **Step 2: Commit**

```bash
git add MiroFish/frontend/src/components/ui/AgentMessageDock.vue
git commit -m "refactor: rewrite AgentMessageDock as floating overlapping avatar stack"
```

---

### Task 5: Add Profile Normalization and State to SimulationView

**Files:**
- Modify: `frontend/src/views/SimulationView.vue`

- [ ] **Step 1: Add imports and agent state refs**

In `SimulationView.vue`, add the new imports after the existing imports (line 118-123):

Add after `import { getPendingUpload } from '../store/pendingUpload'`:

```javascript
import AgentDetailOverlay from '../components/ui/AgentDetailOverlay.vue'
import AgentMessageDock from '../components/ui/AgentMessageDock.vue'
import { getSimulationProfilesRealtime } from '../api/simulation'
import { getAvatarUrl } from '../utils/avatarResolver'
```

Add new refs after `const minutesPerRound = ref(30)` (line 196):

```javascript
const agentProfiles = ref([])
const selectedAgentId = ref(null)
```

- [ ] **Step 2: Add profile normalization function**

Add after the new refs:

```javascript
const normalizeProfiles = (rawProfiles) => {
  return rawProfiles.map((profile, index) => {
    const name = profile.username || profile.name || profile.agent_name || `Agent ${index + 1}`
    return {
      id: profile.agent_id ?? profile.id ?? index,
      name,
      entityType: profile.entity_type || profile.profession || 'Researcher',
      bio: profile.bio || '',
      persona: profile.persona || '',
      researchRole: profile.research_role || profile.role || '',
      responsibility: profile.responsibility || '',
      evidencePriority: profile.evidence_priority || '',
      skills: profile.skills || [],
      worldActions: profile.world_actions || [],
      peerActions: profile.peer_actions || [],
      challengeTargets: profile.challenge_targets || [],
      qualificationScore: profile.qualification_score || 0,
      avatarPath: getAvatarUrl(index),
      initials: String(name)
        .split(/\s+/)
        .filter(Boolean)
        .slice(0, 2)
        .map((part) => part[0])
        .join('')
        .toUpperCase(),
      roleEmoji: roleEmojiForProfile(profile.research_role)
    }
  })
}

const roleEmojiForProfile = (role) => {
  const lowered = String(role || '').toLowerCase()
  if (lowered.includes('challenge')) return '\u2694\uFE0F'
  if (lowered.includes('fact')) return '\u2705'
  if (lowered.includes('domain')) return '\uD83D\uDD2C'
  if (lowered.includes('synth')) return '\uD83E\uDDEC'
  if (lowered.includes('method')) return '\uD83D\uDCD0'
  if (lowered.includes('editor')) return '\u270D\uFE0F'
  return '\uD83E\uDDE0'
}

const selectedAgent = computed(() => {
  if (selectedAgentId.value === null) return null
  return agentProfiles.value.find((a) => a.id === selectedAgentId.value) || null
})

const openAgentDetail = (id) => {
  selectedAgentId.value = id
}

const closeAgentDetail = () => {
  selectedAgentId.value = null
}
```

- [ ] **Step 3: Add profile fetching into hydrateWorkspace**

Inside the `hydrateWorkspace` function, after the `simulationUnlocked.value = Boolean(...)` block (around line 422), add:

```javascript
      // Fetch agent profiles for roster
      try {
        const profilesRes = await getSimulationProfilesRealtime(currentSimulationId.value, 'reddit')
        if (profilesRes?.success && profilesRes.data?.profiles) {
          agentProfiles.value = normalizeProfiles(profilesRes.data.profiles)
        }
      } catch {
        // Profiles may not exist yet
      }
```

- [ ] **Step 4: Add template elements**

In the template, add AgentMessageDock before `</aside>` closing tag and AgentDetailOverlay before `</div>` (the root `.workspace-view` closing tag):

After `</aside>` (line 106) and before the closing `</div>`:

```html
    <AgentMessageDock
      :profiles="agentProfiles"
      :simulationId="currentSimulationId"
      @agent-click="openAgentDetail"
    />

    <AgentDetailOverlay
      :agent="selectedAgent"
      @close="closeAgentDetail"
    />
```

- [ ] **Step 5: Pass profiles and openAgentDetail to Step2EnvSetup**

Update the `<Step2EnvSetup>` component in the template to pass agent profiles:

Change the existing Step2EnvSetup element to add new props:

```html
          <Step2EnvSetup
            v-else-if="activeStage === 'environment' && hasRealSimulation"
            :simulationId="currentSimulationId"
            :projectData="projectData"
            :graphData="graphData"
            :configMode="workspaceConfigMode"
            :systemLogs="systemLogs"
            :autoStart="environmentAutoStart"
            :agentProfiles="agentProfiles"
            @go-back="goHome"
            @next-step="handleEnvironmentNext"
            @add-log="addLog"
            @update-status="updateWorkspaceStatus"
            @agent-click="openAgentDetail"
            @profiles-updated="handleProfilesUpdated"
          />
```

Add the handler:

```javascript
const handleProfilesUpdated = (rawProfiles) => {
  agentProfiles.value = normalizeProfiles(rawProfiles)
}
```

- [ ] **Step 6: Pass profiles to Step3Simulation**

Update Step3Simulation in the template to add the profiles prop:

```html
          <Step3Simulation
            v-if="activeStage === 'simulation' && simulationUnlocked"
            :simulationId="currentSimulationId"
            :maxRounds="currentMaxRounds"
            :projectData="projectData"
            :graphData="graphData"
            :systemLogs="systemLogs"
            :minutesPerRound="minutesPerRound"
            :embedded="true"
            :reportStarted="reportStarted"
            :agentProfiles="agentProfiles"
            @go-back="selectStage('environment')"
            @next-step="handleSimulationNext"
            @add-log="addLog"
            @update-status="updateWorkspaceStatus"
          />
```

- [ ] **Step 7: Commit**

```bash
git add MiroFish/frontend/src/views/SimulationView.vue
git commit -m "feat: lift agent profile state to SimulationView, wire dock + overlay"
```

---

### Task 6: Update Step2EnvSetup — Sandbox Shimmer + AgentGrid

**Files:**
- Modify: `frontend/src/components/Step2EnvSetup.vue`

- [ ] **Step 1: Add new imports and props**

Add import for AgentGrid after the existing imports (line 276):

```javascript
import AgentGrid from './ui/AgentGrid.vue'
```

Add new props to the defineProps (after `compactMode` prop around line 291):

```javascript
  agentProfiles: {
    type: Array,
    default: () => []
  }
```

Add new emit to defineEmits (line 294):

```javascript
const emit = defineEmits(['go-back', 'next-step', 'add-log', 'update-status', 'agent-click', 'profiles-updated'])
```

- [ ] **Step 2: Emit profiles-updated when profiles change**

In the `fetchProfilesRealtime` function (around line 709), after `profiles.value = res.data.profiles || []` (line 717), add:

```javascript
      emit('profiles-updated', profiles.value)
```

Also in the `loadPreparedData` function, after profiles are set, add the same emit. Find where `profiles.value = ...` is set in that function and add `emit('profiles-updated', profiles.value)` after it.

- [ ] **Step 3: Add shimmer animation to sandbox-hero**

In the template, update the `sandbox-hero` section. Add a shimmer overlay inside `sandbox-copy` (after line 5, inside `<section class="sandbox-hero">`):

Add inside `sandbox-copy` div, before the `<span class="hero-kicker">`:

```html
          <Transition name="shimmer-fade">
            <div v-if="prepareStarted && profiles.length === 0" class="sandbox-shimmer">
              <div class="shimmer-bar"></div>
              <span class="shimmer-text">Creating Sandbox...</span>
            </div>
          </Transition>
```

- [ ] **Step 4: Replace profile cards with AgentGrid**

Replace the existing profiles-list section (lines 128-153, the `<div v-if="profiles.length > 0" class="profiles-list">...</div>`) with:

```html
          <AgentGrid
            v-if="agentProfiles.length > 0"
            :profiles="agentProfiles"
            @agent-click="(id) => $emit('agent-click', id)"
          />

          <div v-else-if="profiles.length === 0" class="empty-state">
            <span>Agent profiles are being prepared.</span>
          </div>
```

Remove the old `selectProfile` function and `selectedProfile` ref since the modal is now handled by AgentDetailOverlay in SimulationView. Also remove the `<Transition name="modal">` block (lines 222-262) that renders the old profile modal overlay.

- [ ] **Step 5: Add shimmer CSS**

Add to the `<style scoped>` section:

```css
/* Sandbox shimmer animation */
.sandbox-shimmer {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  background: rgba(250, 249, 244, 0.9);
  border-radius: 12px;
  z-index: 2;
}

.shimmer-bar {
  width: 200px;
  height: 4px;
  border-radius: 2px;
  background: linear-gradient(90deg, #e3e0db 25%, #d4d0ca 50%, #e3e0db 75%);
  background-size: 200% 100%;
  animation: shimmer-sweep 1.5s ease-in-out infinite;
}

.shimmer-text {
  font-size: 12px;
  font-weight: 600;
  color: #737373;
  letter-spacing: 0.04em;
}

@keyframes shimmer-sweep {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}

.shimmer-fade-enter-active,
.shimmer-fade-leave-active {
  transition: opacity 0.2s ease;
}

.shimmer-fade-enter-from,
.shimmer-fade-leave-to {
  opacity: 0;
}
```

- [ ] **Step 6: Make sandbox-hero position relative**

Ensure `.sandbox-hero` has `position: relative` so the shimmer overlay positions correctly. Find the existing `.sandbox-hero` CSS rule and add `position: relative;` if not already present.

- [ ] **Step 7: Commit**

```bash
git add MiroFish/frontend/src/components/Step2EnvSetup.vue
git commit -m "feat: add sandbox shimmer + replace profile cards with AgentGrid"
```

---

### Task 7: Remove Old AgentMessageDock from App.vue

**Files:**
- Modify: `frontend/src/App.vue`

The dock is now rendered inside SimulationView, so remove it from App.vue to avoid duplicates.

- [ ] **Step 1: Remove dock from App.vue template**

Remove lines 3-6 from App.vue:

```html
    <AgentMessageDock
      v-if="showSimulationOverlay"
      :simulation-id="currentSimulationId"
    />
```

- [ ] **Step 2: Remove the import**

Remove line 59:

```javascript
import AgentMessageDock from './components/ui/AgentMessageDock.vue'
```

- [ ] **Step 3: Check other usages and clean up**

Check `PaperReportView.vue` and `Step5Interaction.vue` — these also import AgentMessageDock. These views are outside the SimulationView workspace, so they need their own dock instances. Leave those as-is for now; they will continue using the refactored dock component and just need to pass normalized profiles. This is a follow-up concern.

- [ ] **Step 4: Commit**

```bash
git add MiroFish/frontend/src/App.vue
git commit -m "refactor: remove AgentMessageDock from App.vue (now in SimulationView)"
```

---

### Task 8: Verify End-to-End in Browser

**Files:** None (testing only)

- [ ] **Step 1: Start the dev server**

```bash
cd /Users/amar/HIVE-MIND/MiroFish/frontend && npm run dev
```

- [ ] **Step 2: Open a simulation workspace in browser**

Navigate to an existing simulation URL (e.g., `http://localhost:5173/simulation/sim_1cf2f83fb3bb?stage=environment`).

Verify:
1. Environment stage loads, sandbox shimmer appears briefly during preparation
2. Agent cards appear in a responsive grid with staggered fade-in
3. Floating dock appears in bottom-left corner as agents populate
4. Hovering the dock spreads avatars apart
5. Clicking any agent (grid or dock) opens the glassmorphism overlay with full profile details
6. Pressing Escape or clicking backdrop closes the overlay
7. Switching to Simulation stage: agent cards in grid disappear (stage changes), but dock persists
8. Dock shows green pulse on agents with recent activity

- [ ] **Step 3: Test responsive behavior**

Resize the drawer wider/narrower and verify agent grid reflows columns automatically.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A MiroFish/frontend/src/
git commit -m "fix: address visual issues found during browser testing"
```

---

## File Map Summary

| File | Action | Purpose |
|------|--------|---------|
| `frontend/src/assets/avatars/.gitkeep` | Create | SVG avatar folder placeholder |
| `frontend/src/utils/avatarResolver.js` | Create | Deterministic avatar URL resolver |
| `frontend/src/components/ui/AgentDetailOverlay.vue` | Create | Fullscreen glassmorphism popup |
| `frontend/src/components/ui/AgentGrid.vue` | Create | Responsive agent card grid |
| `frontend/src/components/ui/AgentMessageDock.vue` | Rewrite | Floating overlapping avatar stack |
| `frontend/src/views/SimulationView.vue` | Modify | State owner, renders dock + overlay |
| `frontend/src/components/Step2EnvSetup.vue` | Modify | Shimmer animation, AgentGrid integration |
| `frontend/src/App.vue` | Modify | Remove old dock instance |

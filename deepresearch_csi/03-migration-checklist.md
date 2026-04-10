# Deep Research Component Refactoring: Migration Checklist

**Timeline:** 2 days | **Effort:** 16-20 hours | **Risk:** Medium-Low (components are backward-compatible)

---

## Pre-Migration

- [ ] **Branch strategy:** Create feature branch `refactor/deep-research-components`
- [ ] **Backup current:** Commit current DeepResearch.jsx as baseline
- [ ] **Notify team:** Let team know components are being refactored (no breaking changes to API)
- [ ] **Prepare rollback:** Tag current main as `deep-research-v2` for quick rollback

---

## Day 1: Extract Components (8 hours)

### Morning (0-2 hours): GraphVisualization.jsx

- [ ] Create `/frontend/Da-vinci/src/components/hivemind/app/components/GraphVisualization.jsx`
- [ ] Copy constants (ACTION_BADGES, AGENT_COLORS, RUNTIME_BADGES, NODE_ICONS)
- [ ] Extract graph rendering logic from DeepResearch.jsx lines 409-1700
- [ ] Create proper TypeScript/JSDoc interface for props
- [ ] Test with mock data:
  ```javascript
  const mockData = {
    nodes: [
      { id: 'n1', title: 'Node 1', color: '#117dff', val: 8, type: 'source' },
      { id: 'n2', title: 'Node 2', color: '#16a34a', val: 10, type: 'claim' },
    ],
    links: [
      { source: 'n1', target: 'n2', color: '#16a34a40' },
    ],
  };
  ```
- [ ] Verify all layer toggles work
- [ ] Verify custom nodeCanvasObject renders correctly

### Late Morning (2-4 hours): StatusTab.jsx

- [ ] Create `/frontend/Da-vinci/src/components/hivemind/app/components/StatusTab.jsx`
- [ ] Extract EventCard component (lines 78-400)
- [ ] Extract event rendering logic
- [ ] Test with mock events:
  ```javascript
  const mockEvents = [
    { type: 'task.reasoning', action: 'SEARCH_WEB', thought: 'Searching for...' },
    { type: 'source.found', title: 'Example.com', url: 'https://example.com' },
  ];
  ```
- [ ] Verify auto-scroll works
- [ ] Verify agent status bar displays

### Afternoon (4-6 hours): ReportTab.jsx & ResearchInput.jsx

- [ ] Create `/frontend/Da-vinci/src/components/hivemind/app/components/ReportTab.jsx`
  - [ ] Extract markdown rendering (lines 55-75)
  - [ ] Extract report display (lines 1400-1520)
  - [ ] Test markdown rendering with complex markdown input
  - [ ] Test findings display

- [ ] Create `/frontend/Da-vinci/src/components/hivemind/app/components/ResearchInput.jsx`
  - [ ] Extract search bar UI
  - [ ] Extract session management UI
  - [ ] Test input submission
  - [ ] Test session loading

### Late Afternoon (6-8 hours): ResearchPanel.jsx

- [ ] Create `/frontend/Da-vinci/src/components/hivemind/app/components/ResearchPanel.jsx`
- [ ] Implement tab switching (status → report → graph)
- [ ] Implement panel resize (compact → medium → large)
- [ ] Implement graph detach/reattach logic
- [ ] Test all transitions with real data

---

## Day 2: Refactor & Deploy (8-10 hours)

### Morning (0-3 hours): Refactor DeepResearch.jsx

- [ ] **Backup current DeepResearch.jsx** in git
- [ ] **Delete all rendering logic** (keep orchestration only)
- [ ] **Keep SSE/polling setup** (lines 750-850 refactored)
- [ ] **Keep state management** (session, events, report)
- [ ] **Keep data fetching** (fetchGraphData, fetchTrailSteps)
- [ ] **Refactor render** to use child components:
  ```javascript
  return (
    <div className="h-screen flex flex-col">
      <ResearchInput {...inputProps} />
      <ResearchPanel {...panelProps} />
    </div>
  );
  ```
- [ ] **Test locally** that old DeepResearch.jsx still works
- [ ] **Check for missing props** passed to children

### Late Morning (3-5 hours): Integration Testing

- [ ] **Verify SSE streaming** still works
  - [ ] Start research
  - [ ] Check events appear in timeline
  - [ ] Check agent status updates
  - [ ] Check research completes

- [ ] **Verify polling fallback** still works
  - [ ] Disconnect internet briefly
  - [ ] Verify polling kicks in
  - [ ] Check events still update

- [ ] **Verify graph display**
  - [ ] Open graph tab
  - [ ] Check nodes/links render
  - [ ] Check layer toggles work
  - [ ] Check graph detach works

- [ ] **Verify timeline visibility** (the original issue)
  - [ ] Start research
  - [ ] Switch to graph tab
  - [ ] Watch events continue flowing
  - [ ] Switch back to status tab
  - [ ] Events should be visible

### Afternoon (5-7 hours): Regression Testing

- [ ] **Run existing tests** (if any)
  ```bash
  cd /opt/HIVEMIND/frontend/Da-vinci
  npm test -- DeepResearch
  ```

- [ ] **Test on mobile** (responsive panel)
- [ ] **Test with large graph** (100+ nodes)
- [ ] **Test with no events** (empty timeline)
- [ ] **Test error states** (failed research, network errors)
- [ ] **Test edge cases:**
  - [ ] Multiple research sessions in a row
  - [ ] Tab switching during active research
  - [ ] Graph refresh while running
  - [ ] Panel resize during streaming

### Late Afternoon (7-8 hours): Performance Verification

- [ ] **Check no performance regression**
  - [ ] Graph renders smoothly with 100+ nodes
  - [ ] Tab switching is instantaneous
  - [ ] Panel resize is smooth
  - [ ] Memory usage comparable to original

- [ ] **Check bundle size** (should not increase)
  ```bash
  npm run build -- --analyze
  ```

### Evening (8-10 hours): Preparation for Deployment

- [ ] **Update import paths** in any files that import DeepResearch
- [ ] **Create commit message** documenting the refactoring
- [ ] **Prepare deployment notes** (no breaking changes, improved maintainability)
- [ ] **Get code review** from team lead
- [ ] **Prepare rollback plan** (tag current as rollback point)

---

## Deployment Checklist

### Pre-Deployment (1 hour before)

- [ ] **Verify all tests pass**
- [ ] **Final regression testing** on staging
- [ ] **Check no console warnings**
- [ ] **Verify bundle size** didn't increase significantly
- [ ] **Get approval** from product/engineering lead

### Deployment (5 minutes)

- [ ] **Merge to main** with commit message: `refactor(deep-research): decompose into reusable components`
- [ ] **Deploy to production** (or staging for phased rollout)
- [ ] **Monitor metrics:**
  - Sentry error rate (should be flat)
  - Core Web Vitals (LCP, FID, CLS should improve or stay same)
  - Deep Research page load time

### Post-Deployment (24 hours)

- [ ] **Monitor for 24 hours** for any issues
- [ ] **Check user analytics** (research completion rate should not decrease)
- [ ] **Check SSE streaming** in production
- [ ] **Check polling fallback** (test by disabling SSE)
- [ ] **Verify timeline visibility issue** is resolved
- [ ] **Collect feedback** from team

---

## Success Criteria

### Timeline Visibility Issue ✅

**Before:** Events disappear when user switches tabs  
**After:** Events always visible in StatusTab, regardless of graph state

**Verification:**
1. Start research
2. Switch to graph tab → observe events continue showing in background
3. Switch back to status tab → all events visible
4. Manually append new events (via API) → verify they appear

### Component Reusability ✅

**Goal:** GraphVisualization can be imported and used elsewhere

**Verification:**
1. Import GraphVisualization in MemoryGraph component
2. Pass mock data
3. Verify graph renders correctly
4. No need to modify GraphVisualization code

### Code Quality ✅

**Metrics:**
- DeepResearch.jsx: 2056 lines → 300 lines (85% reduction)
- GraphVisualization: 400 lines (self-contained)
- StatusTab: 300 lines (pure component)
- ReportTab: 200 lines (pure component)
- All components individually testable

### Performance ✅

**Benchmarks:**
- First interaction delay: < 50ms
- Tab switch time: < 100ms
- Graph render time: < 200ms (100+ nodes)
- Memory usage: comparable to original

---

## Rollback Plan

**If critical issues found:**

```bash
# Rollback to previous version
git revert <commit-sha>
git push

# Or revert to tagged version
git reset --hard deep-research-v2
git push --force

# Notify team
Slack: "Rolled back deep research components due to [issue]. Investigating."
```

**Critical issues that trigger rollback:**
- SSE streaming stops working
- Research completion doesn't update UI
- Graph doesn't render (white screen)
- Memory leak on timeline with 1000+ events
- Mobile layout breaks

---

## Reusability Actions (After Deployment)

### 1. Update MemoryGraph.jsx (Next Day)

```javascript
// Before
import ForceGraph2D from 'react-force-graph-2d';

// After
import GraphVisualization from './GraphVisualization';

// In render:
<GraphVisualization
  data={memoryGraphData}
  layers={graphLayers}
  onNodeClick={handleNodeClick}
  // ... other props
/>
```

**Expected benefit:** Remove 200+ lines of duplicated graph code from MemoryGraph

### 2. Document GraphVisualization API

- [ ] Create JSDoc comments in GraphVisualization.jsx
- [ ] Add examples for common use cases
- [ ] Document all props and callbacks
- [ ] Add to component library documentation

### 3. Use in Future Features

- [ ] Tara session visualization
- [ ] Collaborative research viewing
- [ ] Research comparison view
- [ ] Knowledge base visualization

---

## Common Pitfalls & Solutions

| Pitfall | Solution |
|---------|----------|
| **Events not showing after tab switch** | Verify events are in React state, not component state |
| **Graph flickers on re-render** | Use `React.memo` on GraphVisualization |
| **SSE stops after error** | Check fallback polling interval is set correctly |
| **Props drilling hell** | Use context for sessionId, userId at top level |
| **Tests fail** | Mock apiClient properly, use data-testid for queries |
| **Performance degrades** | Profile with React DevTools, check for unnecessary re-renders |

---

## File Checklist

### Files to Create
- [ ] `GraphVisualization.jsx` (400 lines)
- [ ] `StatusTab.jsx` (300 lines)
- [ ] `ReportTab.jsx` (200 lines)
- [ ] `ResearchInput.jsx` (150 lines)
- [ ] `ResearchPanel.jsx` (400 lines)

### Files to Modify
- [ ] `DeepResearch.jsx` (refactor from 2056 to 300 lines)

### Files NOT to Touch
- [ ] `/core/src/server.js` (no changes needed)
- [ ] `/core/src/deep-research/researcher.js` (no changes needed)
- [ ] API client (no changes needed)

### Files to Document
- [ ] GraphVisualization.jsx - Add comprehensive JSDoc
- [ ] ResearchPanel.jsx - Explain prop passing strategy
- [ ] DeepResearch.jsx - Mark sections as "orchestrator only"

---

## Git Workflow

```bash
# Create feature branch
git checkout -b refactor/deep-research-components

# Commit components progressively
git add GraphVisualization.jsx
git commit -m "feat(components): add reusable GraphVisualization component"

git add StatusTab.jsx ReportTab.jsx
git commit -m "feat(components): add StatusTab and ReportTab components"

git add ResearchInput.jsx ResearchPanel.jsx
git commit -m "feat(components): add ResearchInput and ResearchPanel components"

git add pages/DeepResearch.jsx
git commit -m "refactor(deep-research): decompose into component-based architecture"

# Create PR for review
gh pr create --title "Refactor: Decompose Deep Research into reusable components" \
  --body "Fixes #[timeline-visibility-issue]"

# After approval, merge
git merge --squash refactor/deep-research-components
git commit -m "Merge refactor/deep-research-components

- Extract GraphVisualization as reusable graph component
- Extract StatusTab, ReportTab as pure components
- Decompose DeepResearch into orchestrator pattern
- Fixes: Timeline visibility issue (components are independent)
- Improves: Code reusability, testability, maintainability

BREAKING CHANGES: None (all APIs preserved)"

git push origin main
```

---

## Estimated Timeline

| Phase | Duration | Owner |
|-------|----------|-------|
| Extract GraphVisualization | 2 hours | Dev |
| Extract StatusTab + ReportTab | 2 hours | Dev |
| Extract ResearchInput + ResearchPanel | 2 hours | Dev |
| Refactor DeepResearch | 1 hour | Dev |
| Integration testing | 2 hours | QA |
| Regression testing | 2 hours | QA |
| Performance verification | 1 hour | Dev |
| Code review + deployment prep | 1 hour | Lead |
| **Total** | **13 hours** | - |

**Buffer (for fixes):** +3 hours → **Total: 16-20 hours**

**Deployment window:** Early morning (low traffic)


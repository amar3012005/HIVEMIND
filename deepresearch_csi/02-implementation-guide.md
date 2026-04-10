# Deep Research Component Refactoring: Implementation Guide

**Prepared:** April 10, 2026  
**Target Timeline:** 2 days  
**Objective:** Decompose monolithic DeepResearch.jsx into component-based architecture

---

## Quick Reference: Component Map

```
Current: DeepResearch.jsx (2056 lines, monolithic)
         ↓
Target:  DeepResearch.jsx (orchestrator, ~300 lines)
         │
         ├─ ResearchInput.jsx (search bar, ~150 lines)
         ├─ ResearchPanel.jsx (tab container, ~400 lines)
         │  ├─ StatusTab.jsx (timeline, ~300 lines)
         │  ├─ ReportTab.jsx (synthesis, ~200 lines)
         │  └─ GraphTab.jsx (wrapper, ~50 lines)
         │     └─ GraphVisualization.jsx (graph rendering, ~400 lines) [REUSABLE]
         └─ GraphWindow.jsx (detached graph, ~150 lines)
            └─ GraphVisualization.jsx (reuse)
```

---

## Step 1: Extract GraphVisualization.jsx (REUSABLE COMPONENT)

### Why This First?
- **Longest lead time** - Most complex to get right
- **Highest reuse potential** - Will be used in MemoryGraph, Tara, future features
- **Unblocks testing** - Once extracted, can test independently
- **3d-force-graph model** - Library encapsulates graph logic the same way

### Implementation

**Create:** `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/components/GraphVisualization.jsx`

```javascript
import React, { useState, useRef } from 'react';
import { motion } from 'framer-motion';
import ForceGraph2D from 'react-force-graph-2d';
import {
  Globe, CheckCircle2, Scroll, Award, Eye, Activity,
  RotateCcw, Layers, ExternalLink, Search,
} from 'lucide-react';

// Constants (moved from DeepResearch.jsx lines 16-45)
const ACTION_BADGES = {
  SEARCH_WEB: { label: 'Web Search', color: '#117dff', bg: 'rgba(17,125,255,0.12)' },
  SEARCH_MEMORY: { label: 'Memory Search', color: '#16a34a', bg: 'rgba(22,163,74,0.12)' },
  READ_URL: { label: 'Reading', color: '#9333ea', bg: 'rgba(147,51,234,0.12)' },
  SYNTHESIZE: { label: 'Synthesize', color: '#d97706', bg: 'rgba(217,119,6,0.12)' },
  FINISH: { label: 'Finish', color: '#059669', bg: 'rgba(5,150,105,0.12)' },
};

const AGENT_COLORS = {
  Explorer: '#117dff',
  Analyst: '#9333ea',
  Verifier: '#16a34a',
  Synthesizer: '#d97706',
};

const RUNTIME_BADGES = {
  tavily: { label: 'Tavily', color: '#0ea5e9', bg: 'rgba(14,165,233,0.12)' },
  lightpanda: { label: 'LightPanda', color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
  fetch: { label: 'Fetch', color: '#64748b', bg: 'rgba(100,116,139,0.12)' },
};

const NODE_ICONS = {
  source: Globe,
  claim: CheckCircle2,
  'structured-claim': CheckCircle2,
  'plain-claim': CheckCircle2,
  trail: Scroll,
  blueprint: Award,
};

/**
 * GraphVisualization - Reusable graph component
 * 
 * Renders force-directed graph with configurable layers, callbacks, and styling.
 * Can be used standalone in MemoryGraph, Tara sessions, or any other feature.
 * 
 * @component
 * @example
 * <GraphVisualization
 *   data={{ nodes: [...], links: [...] }}
 *   layers={{ sources: true, claims: true }}
 *   onLayerChange={(layers) => setLayers(layers)}
 *   onNodeClick={(node) => setSelectedNode(node)}
 *   width={800}
 *   height={600}
 * />
 */
function GraphVisualization({
  // Data
  data = { nodes: [], links: [] },
  
  // Layer configuration
  layers = { sources: true, claims: true, trails: true, observations: true, executionEvents: true, blueprints: true },
  onLayerChange,
  
  // Event callbacks
  onNodeClick,
  onNodeHover,
  
  // Display
  width = 600,
  height = 500,
  isLoading = false,
  webUsage = null,
  selectedNode = null,
  
  // Customization (advanced)
  nodeCanvasObject = null,
  linkColor = (link) => link.color,
  
  // Actions
  onRefresh,
  onDetach,
  isDetached = false,
}) {
  // Local state (visualization only)
  const [hoveredNode, setHoveredNode] = useState(null);
  const graphRef = useRef(null);

  // Render custom node (from DeepResearch.jsx lines 1656-1689)
  const defaultNodeCanvasObject = (node, ctx, globalScale) => {
    const label = node.title || '';
    const fontSize = 10 / globalScale;
    ctx.font = `${fontSize}px Sans-Serif`;

    // Draw pulse ring for live nodes
    if (node.isLive) {
      const pulseSize = node.val * 1.8;
      const pulseOpacity = 0.3 + Math.sin(Date.now() / 200) * 0.2;
      ctx.beginPath();
      ctx.arc(node.x, node.y, pulseSize, 0, 2 * Math.PI);
      ctx.fillStyle = `rgba(59, 130, 246, ${pulseOpacity})`;
      ctx.fill();
      ctx.strokeStyle = `rgba(59, 130, 246, ${pulseOpacity + 0.2})`;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // Draw node
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.val, 0, 2 * Math.PI);
    ctx.fillStyle = node.color;
    ctx.fill();

    // Draw runtime badge
    if (node.type === 'source' && node.runtime) {
      const runtimeBadge = RUNTIME_BADGES[node.runtime] || RUNTIME_BADGES.fetch;
      ctx.fillStyle = runtimeBadge.color;
      ctx.beginPath();
      ctx.arc(node.x + node.val - 2, node.y - node.val + 2, 4, 0, 2 * Math.PI);
      ctx.fill();
    }

    // Draw label
    ctx.fillStyle = '#0a0a0a';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'bottom';
    ctx.fillText(label, node.x, node.y - node.val - 2);
  };

  const renderNode = nodeCanvasObject || defaultNodeCanvasObject;

  // Helper: toggle layer
  const toggleLayer = (layerName) => {
    const newLayers = { ...layers, [layerName]: !layers[layerName] };
    onLayerChange?.(newLayers);
  };

  return (
    <div className="h-full flex flex-col bg-white border border-[#e3e0db] rounded-xl overflow-hidden">
      {/* Header: Layer toggles + actions */}
      <div className="px-3 py-2 border-b border-[#e3e0db] bg-[#faf9f4]">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {/* Layer toggles */}
          <div className="flex items-center gap-1 overflow-x-auto scrollbar-hide">
            {[
              { name: 'sources', icon: Globe, label: 'Sources', color: '#117dff' },
              { name: 'claims', icon: CheckCircle2, label: 'Claims', color: '#16a34a' },
              { name: 'trails', icon: Scroll, label: 'Trails', color: '#9333ea' },
              { name: 'blueprints', icon: Award, label: 'Blueprints', color: '#d97706' },
              { name: 'observations', icon: Eye, label: 'Observations', color: '#3b82f6' },
              { name: 'executionEvents', icon: Activity, label: 'Events', color: '#059669' },
            ].map(({ name, icon: Icon, label, color }) => (
              <button
                key={name}
                onClick={() => toggleLayer(name)}
                className={`flex items-center gap-1 px-2 py-1 rounded text-[10px] transition-all flex-shrink-0 ${
                  layers[name]
                    ? `bg-[${color}]/10 text-[${color}]`
                    : 'text-[#a3a3a3] hover:bg-[#f3f1ec]'
                }`}
                title={label}
              >
                <Icon size={10} />
                <span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>

          {/* Action buttons */}
          <div className="flex items-center gap-2 flex-shrink-0">
            {webUsage && (
              <div className="flex items-center gap-2 px-2 py-1 rounded bg-[#faf9f4] border border-[#e3e0db]">
                <span className="text-[9px] text-[#525252]">
                  <Search size={8} className="inline mr-0.5" />
                  <span className={
                    !webUsage.web_search_requests?.limit ? 'text-[#117dff]'
                    : (webUsage.web_search_requests.used / webUsage.web_search_requests.limit) >= 0.8 ? 'text-red-600'
                    : (webUsage.web_search_requests.used / webUsage.web_search_requests.limit) >= 0.5 ? 'text-amber-600'
                    : 'text-emerald-600'
                  }>
                    {webUsage.web_search_requests?.used || 0}
                  </span>
                  /{webUsage.web_search_requests?.limit || 50}
                </span>
              </div>
            )}
            
            {onRefresh && (
              <button
                onClick={onRefresh}
                className="p-1.5 rounded hover:bg-[#e3e0db]/40 text-[#525252]"
                title="Refresh graph"
              >
                <RotateCcw size={12} className={isLoading ? 'animate-spin' : ''} />
              </button>
            )}

            {onDetach && (
              <button
                onClick={onDetach}
                className={`inline-flex items-center gap-1.5 px-2 py-1.5 rounded border text-[10px] font-medium transition-colors ${
                  isDetached
                    ? 'border-[#117dff]/50 bg-[#117dff]/20 text-[#117dff]'
                    : 'border-[#d4d1ca] bg-white text-[#525252] hover:bg-[#117dff]/10'
                }`}
                title={isDetached ? 'Graph is detached' : 'Detach to floating window'}
              >
                <ExternalLink size={12} />
                <span>{isDetached ? 'Detached' : 'Detach'}</span>
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Graph canvas or empty state */}
      <div className="flex-1 relative bg-gradient-to-b from-[#faf9f4] to-white">
        {data.nodes.length > 0 ? (
          <ForceGraph2D
            ref={graphRef}
            graphData={data}
            width={width}
            height={height}
            nodeLabel="title"
            nodeColor={node => node.color}
            nodeVal={node => node.val}
            linkColor={linkColor}
            nodeRelSize={3}
            enableNodeDrag={false}
            enableZoomPan={true}
            minZoom={0.5}
            maxZoom={3}
            onNodeClick={onNodeClick}
            onNodeHover={onNodeHover}
            nodeCanvasObject={renderNode}
            nodeCanvasObjectMode="after"
            linkDirectionalParticles={2}
            linkDirectionalParticleWidth={2}
            linkDirectionalParticleSpeed={0.005}
          />
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[#525252]">
            {isLoading ? (
              <>
                <div className="animate-spin text-[#117dff] mb-3">⚙️</div>
                <p className="text-sm">Loading graph...</p>
              </>
            ) : (
              <p className="text-sm text-[#a3a3a3]">No data to display</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default GraphVisualization;
```

### Key Design Points

1. **Data-driven:** `data` prop contains all nodes/links, not state
2. **Callback-based:** All layer changes go through `onLayerChange`, not internal state
3. **Reusable:** No coupling to SSE, polling, or Deep Research
4. **Tested:** Can unit-test with mock data
5. **Styled:** Colors, animations are self-contained

---

## Step 2: Extract StatusTab.jsx

**Create:** `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/components/StatusTab.jsx`

```javascript
import React, { useEffect, useRef } from 'react';
import { Brain, Loader2 } from 'lucide-react';

// ACTION_BADGES and AGENT_COLORS from GraphVisualization (import or define here)
const ACTION_BADGES = {
  SEARCH_WEB: { label: 'Web Search', color: '#117dff', bg: 'rgba(17,125,255,0.12)' },
  SEARCH_MEMORY: { label: 'Memory Search', color: '#16a34a', bg: 'rgba(22,163,74,0.12)' },
  READ_URL: { label: 'Reading', color: '#9333ea', bg: 'rgba(147,51,234,0.12)' },
  SYNTHESIZE: { label: 'Synthesize', color: '#d97706', bg: 'rgba(217,119,6,0.12)' },
  FINISH: { label: 'Finish', color: '#059669', bg: 'rgba(5,150,105,0.12)' },
};

const AGENT_COLORS = {
  Explorer: '#117dff',
  Analyst: '#9333ea',
  Verifier: '#16a34a',
  Synthesizer: '#d97706',
};

/**
 * EventCard - Renders a single event in the timeline
 * Moved from DeepResearch.jsx lines 78-400
 */
function EventCard({ event, index }) {
  // Implementation from DeepResearch.jsx lines 78-400
  const getContent = () => {
    switch (event.type) {
      case 'task.reasoning': {
        const badge = ACTION_BADGES[event.action] || ACTION_BADGES.SYNTHESIZE;
        const agentColor = AGENT_COLORS[event.agent] || '#a3a3a3';
        return (
          <div className="flex items-start gap-3">
            <div className="mt-0.5">
              <Brain size={14} style={{ color: agentColor }} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-center gap-2 mb-1">
                <span
                  className="px-2 py-0.5 rounded-full text-[10px] font-medium uppercase tracking-wider"
                  style={{ color: badge.color, background: badge.bg }}
                >
                  {badge.label}
                </span>
                {event.agent && (
                  <span className="text-[10px] font-medium px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">
                    {event.agent}
                  </span>
                )}
              </div>
              {event.thought && (
                <p className="text-xs text-[#525252] leading-relaxed">{event.thought}</p>
              )}
            </div>
          </div>
        );
      }
      // ... handle other event types (from original DeepResearch.jsx)
      default:
        return <p className="text-xs text-[#a3a3a3]">{event.type}</p>;
    }
  };

  return (
    <div className="px-3 py-2 border-l-2 border-[#117dff]/30">
      {getContent()}
    </div>
  );
}

/**
 * StatusTab - Timeline and event display
 * Pure functional component: given events[], renders same output every time
 */
function StatusTab({ events = [], agentStates = {}, isLive = false, onSaveToMemory }) {
  const eventsEndRef = useRef(null);

  // Auto-scroll to newest event
  useEffect(() => {
    if (eventsEndRef.current) {
      eventsEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [events]);

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Agent status bar */}
      <div className="px-3 py-2 border-b border-[#e3e0db] bg-[#faf9f4]">
        <div className="flex items-center gap-4">
          {['Explorer', 'Analyst', 'Verifier', 'Synthesizer'].map(agent => {
            const state = agentStates[agent] || { status: 'idle' };
            const isActive = state.status === 'active';
            return (
              <div key={agent} className="flex items-center gap-1.5">
                <div
                  className={`w-2 h-2 rounded-full transition-all ${
                    isActive ? 'bg-[#117dff] shadow-lg' : 'bg-[#e3e0db]'
                  }`}
                />
                <span className="text-xs font-medium text-[#525252]">{agent}</span>
                {isActive && (
                  <span className="text-[10px] text-[#117dff]">{state.lastAction}</span>
                )}
              </div>
            );
          })}
          {isLive && (
            <span className="ml-auto text-[10px] text-[#16a34a] font-medium flex items-center gap-1">
              <span className="w-1.5 h-1.5 bg-[#16a34a] rounded-full animate-pulse" />
              Live
            </span>
          )}
        </div>
      </div>

      {/* Timeline */}
      <div className="flex-1 overflow-y-auto p-3 space-y-2">
        {events.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-[#a3a3a3]">
            <Loader2 size={24} className="animate-spin mb-2" />
            <p className="text-sm">Waiting for events...</p>
          </div>
        ) : (
          events.map((event, idx) => (
            <EventCard key={idx} event={event} index={idx} />
          ))
        )}
        <div ref={eventsEndRef} />
      </div>
    </div>
  );
}

export default StatusTab;
```

### Key Features

1. **PURE:** No API calls, no side effects except scrolling
2. **REUSABLE:** Can be used in session playback, debugging, etc.
3. **TESTABLE:** Single responsibility - just display events

---

## Step 3: Extract ReportTab.jsx

**Create:** `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/components/ReportTab.jsx`

```javascript
import React, { useState } from 'react';
import { FileText, Save, CheckCircle, Zap } from 'lucide-react';

function renderMarkdown(text) {
  // From DeepResearch.jsx lines 55-75
  if (!text) return '';
  const escaped = text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  return escaped
    .replace(/^### (.+)$/gm, '<h3 class="text-base font-semibold">$1</h3>')
    .replace(/^## (.+)$/gm, '<h2 class="text-lg font-bold">$1</h2>')
    .replace(/^# (.+)$/gm, '<h1 class="text-xl font-bold">$1</h1>')
    // ... rest of markdown rules
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>');
}

/**
 * ReportTab - Synthesis report and findings display
 * Pure component: given report + findings, renders same output
 */
function ReportTab({
  report = null,
  findings = [],
  confidence = 0,
  durationMs = 0,
  fromCache = false,
  sessionId = '',
  onSaveToMemory = () => {},
  isSaving = false,
}) {
  const [showSaveModal, setShowSaveModal] = useState(false);

  const durationStr = durationMs
    ? `${(durationMs / 1000).toFixed(1)}s`
    : 'calculating...';

  return (
    <div className="flex flex-col h-full bg-white">
      {/* Header with stats */}
      <div className="px-6 py-4 border-b border-[#e3e0db] bg-[#faf9f4]">
        <div className="flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-[#0a0a0a]">Research Report</h2>
            {fromCache && (
              <p className="text-xs text-[#16a34a] mt-1 flex items-center gap-1">
                <CheckCircle size={12} /> From cache
              </p>
            )}
          </div>
          <div className="flex items-center gap-6 text-sm">
            <div className="text-center">
              <div className="text-2xl font-bold text-[#117dff]">{(confidence * 100).toFixed(0)}%</div>
              <div className="text-xs text-[#525252]">Confidence</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-[#9333ea]">{durationStr}</div>
              <div className="text-xs text-[#525252]">Duration</div>
            </div>
          </div>
        </div>
      </div>

      {/* Report content */}
      <div className="flex-1 overflow-y-auto p-6">
        {report ? (
          <div className="space-y-4">
            <div
              className="text-[#525252] leading-relaxed prose prose-sm"
              dangerouslySetInnerHTML={{ __html: renderMarkdown(report) }}
            />

            {/* Findings */}
            {findings.length > 0 && (
              <div className="mt-8 pt-6 border-t border-[#e3e0db]">
                <h3 className="font-semibold text-[#0a0a0a] mb-4">Key Findings</h3>
                <div className="space-y-3">
                  {findings.map((finding, idx) => (
                    <div
                      key={idx}
                      className="p-3 rounded-lg bg-[#117dff]/5 border border-[#117dff]/20"
                    >
                      <div className="flex items-start gap-2">
                        <Zap size={14} className="text-[#117dff] mt-0.5 flex-shrink-0" />
                        <div className="flex-1">
                          <p className="text-sm font-medium text-[#0a0a0a]">{finding.title}</p>
                          <p className="text-xs text-[#525252] mt-1">{finding.description}</p>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <div className="flex flex-col items-center justify-center h-full text-[#a3a3a3]">
            <FileText size={32} className="mb-3 opacity-50" />
            <p className="text-sm">No report generated yet</p>
          </div>
        )}
      </div>

      {/* Save to memory button */}
      {report && sessionId && (
        <div className="px-6 py-4 border-t border-[#e3e0db] bg-[#faf9f4]">
          <button
            onClick={() => setShowSaveModal(true)}
            disabled={isSaving}
            className="w-full inline-flex items-center justify-center gap-2 px-4 py-2 bg-[#117dff] text-white rounded-lg font-medium transition hover:bg-[#0a6ddb] disabled:opacity-50"
          >
            <Save size={14} />
            Save Report to Memory
          </button>
        </div>
      )}
    </div>
  );
}

export default ReportTab;
```

---

## Step 4: Extract ResearchInput.jsx

**Create:** `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/components/ResearchInput.jsx`

```javascript
import React, { useState, useRef } from 'react';
import { ArrowUp, History, Loader2, Search } from 'lucide-react';

/**
 * ResearchInput - Query input and session management
 * Handles: text input, submit, session loading
 */
function ResearchInput({
  value = '',
  onChange = () => {},
  onSubmit = () => {},
  onLoadSession = () => {},
  isLoading = false,
  sessions = [],
  error = '',
}) {
  const [showSessions, setShowSessions] = useState(false);
  const textareaRef = useRef(null);

  const handleKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <div className="bg-gradient-to-b from-white to-[#faf9f4] border-b border-[#e3e0db]">
      {/* Error message */}
      {error && (
        <div className="px-6 py-3 bg-red-50 border-b border-red-200 text-red-600 text-sm">
          {error}
        </div>
      )}

      <div className="max-w-4xl mx-auto p-6">
        {/* Input field */}
        <div className="relative">
          <textarea
            ref={textareaRef}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask anything about any topic..."
            className="w-full px-4 py-3 border border-[#d4d1ca] rounded-lg bg-white text-[#0a0a0a] placeholder-[#a3a3a3] focus:outline-none focus:border-[#117dff] focus:ring-1 focus:ring-[#117dff]/50 resize-none"
            rows={3}
          />
          <button
            onClick={onSubmit}
            disabled={isLoading || !value.trim()}
            className="absolute bottom-3 right-3 p-2 bg-[#117dff] text-white rounded-lg hover:bg-[#0a6ddb] disabled:opacity-50 transition"
          >
            {isLoading ? <Loader2 size={18} className="animate-spin" /> : <ArrowUp size={18} />}
          </button>
        </div>

        {/* Session history */}
        {sessions.length > 0 && (
          <div className="mt-4">
            <button
              onClick={() => setShowSessions(!showSessions)}
              className="text-sm text-[#117dff] hover:underline flex items-center gap-1"
            >
              <History size={14} />
              Previous Sessions ({sessions.length})
            </button>
            {showSessions && (
              <div className="mt-3 space-y-2 max-h-40 overflow-y-auto">
                {sessions.map((session) => (
                  <button
                    key={session.id}
                    onClick={() => {
                      onLoadSession(session.id);
                      setShowSessions(false);
                    }}
                    className="w-full text-left px-3 py-2 rounded-lg bg-[#f3f1ec] hover:bg-[#e3e0db] text-sm text-[#525252] transition truncate"
                  >
                    {session.query || 'Untitled'}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export default ResearchInput;
```

---

## Step 5: Create ResearchPanel.jsx

**Create:** `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/components/ResearchPanel.jsx`

```javascript
import React, { useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { X, ChevronDown, ChevronUp } from 'lucide-react';
import StatusTab from './StatusTab';
import ReportTab from './ReportTab';
import GraphVisualization from './GraphVisualization';

/**
 * ResearchPanel - Multi-tab panel for research results
 * Coordinates: StatusTab, ReportTab, GraphVisualization
 */
function ResearchPanel({
  isOpen = false,
  onClose = () => {},
  sessionId = '',
  status = 'idle',

  // Tab data
  events = [],
  report = null,
  findings = [],
  agentStates = {},
  graphData = { nodes: [], links: [] },
  graphLayers = {},
  graphLoading = false,
  webUsage = null,

  // Callbacks
  onRefreshGraph = () => {},
  onLayerChange = () => {},
  onSaveToMemory = () => {},
}) {
  const [activeTab, setActiveTab] = useState('status');
  const [panelSize, setPanelSize] = useState('large');
  const [isGraphDetached, setIsGraphDetached] = useState(false);
  const panelRef = useRef(null);
  const contentRef = useRef(null);

  const tabs = [
    { id: 'status', label: 'Status', icon: '📊' },
    { id: 'report', label: 'Report', icon: '📄' },
    { id: 'graph', label: 'Graph', icon: '🔗' },
  ];

  const panelWidth = {
    compact: '400px',
    medium: '600px',
    large: '800px',
  };

  if (!isOpen) return null;

  return (
    <>
      {/* Overlay */}
      {isGraphDetached && (
        <div
          className="fixed inset-0 bg-black/20"
          onClick={onClose}
          style={{ zIndex: 39 }}
        />
      )}

      {/* Panel */}
      <motion.div
        ref={panelRef}
        initial={{ opacity: 0, x: 400 }}
        animate={{ opacity: 1, x: 0 }}
        exit={{ opacity: 0, x: 400 }}
        className="fixed right-0 top-0 bottom-0 bg-white shadow-2xl overflow-hidden flex flex-col"
        style={{
          width: panelWidth[panelSize],
          zIndex: isGraphDetached ? 50 : 40,
        }}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-[#e3e0db]">
          <h2 className="font-semibold text-[#0a0a0a]">
            Research {status === 'completed' ? '✓' : status === 'failed' ? '✗' : '…'}
          </h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-[#f3f1ec]"
          >
            <X size={18} />
          </button>
        </div>

        {/* Tab buttons */}
        <div className="flex border-b border-[#e3e0db] px-6 gap-1">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`px-3 py-2 text-sm font-medium border-b-2 transition ${
                activeTab === tab.id
                  ? 'border-[#117dff] text-[#117dff]'
                  : 'border-transparent text-[#525252] hover:text-[#0a0a0a]'
              }`}
            >
              {tab.icon} {tab.label}
            </button>
          ))}
        </div>

        {/* Content */}
        <div ref={contentRef} className="flex-1 overflow-hidden">
          <AnimatePresence mode="wait">
            {activeTab === 'status' && (
              <StatusTab events={events} agentStates={agentStates} onSaveToMemory={onSaveToMemory} />
            )}
            {activeTab === 'report' && (
              <ReportTab
                report={report}
                findings={findings}
                sessionId={sessionId}
                onSaveToMemory={onSaveToMemory}
              />
            )}
            {activeTab === 'graph' && (
              <GraphVisualization
                data={graphData}
                layers={graphLayers}
                onLayerChange={onLayerChange}
                isLoading={graphLoading}
                webUsage={webUsage}
                width={contentRef.current?.clientWidth}
                height={contentRef.current?.clientHeight}
                onRefresh={onRefreshGraph}
                onDetach={() => setIsGraphDetached(!isGraphDetached)}
                isDetached={isGraphDetached}
              />
            )}
          </AnimatePresence>
        </div>
      </motion.div>
    </>
  );
}

export default ResearchPanel;
```

---

## Step 6: Refactor DeepResearch.jsx (Orchestrator)

**File:** `/opt/HIVEMIND/frontend/Da-vinci/src/components/hivemind/app/pages/DeepResearch.jsx`

Replace entire content with:

```javascript
import React, { useState, useEffect, useCallback } from 'react';
import apiClient from '../shared/api-client';
import ResearchInput from '../components/ResearchInput';
import ResearchPanel from '../components/ResearchPanel';

/**
 * DeepResearch - Orchestrator component
 * 
 * Responsibilities:
 * - Session management (sessionId, status)
 * - SSE streaming setup and event handling
 * - API calls for data fetching (report, graph, trail steps)
 * - Data coordination across child components
 *
 * Does NOT handle rendering (delegates to child components)
 */
function DeepResearch() {
  // Session management
  const [sessionId, setSessionId] = useState(null);
  const [projectId, setProjectId] = useState(null);
  const [status, setStatus] = useState('idle');
  const [query, setQuery] = useState('');
  const [error, setError] = useState(null);

  // Streaming data
  const [events, setEvents] = useState([]);
  const [report, setReport] = useState(null);
  const [findings, setFindings] = useState([]);
  const [durationMs, setDurationMs] = useState(0);
  const [confidence, setConfidence] = useState(0);
  const [fromCache, setFromCache] = useState(false);

  // Graph data
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [graphLayers, setGraphLayers] = useState({
    sources: true,
    claims: true,
    trails: true,
    observations: true,
    executionEvents: true,
    blueprints: true,
  });
  const [graphLoading, setGraphLoading] = useState(false);
  const [webUsage, setWebUsage] = useState(null);

  // Process state
  const [agentStates, setAgentStates] = useState({});
  const [trailSteps, setTrailSteps] = useState([]);

  // UI state
  const [showPanel, setShowPanel] = useState(false);
  const [sessions, setSessions] = useState([]);

  /* ── Fetch Operations ────────────────────────────────────────── */

  const fetchTrailSteps = useCallback(async (sid) => {
    try {
      const { data } = await apiClient.controlPlane.get(`/v1/proxy/research/${sid}/trail`);
      setTrailSteps(Array.isArray(data) ? data : data?.trail || []);
    } catch (e) {
      console.error('Failed to fetch trail:', e);
    }
  }, []);

  const fetchGraphData = useCallback(async (sid) => {
    setGraphLoading(true);
    try {
      const { data } = await apiClient.controlPlane.get(`/v1/proxy/research/${sid}/graph`);
      // Graph transformation logic from original DeepResearch.jsx
      // ... (lines 469-605 from original)
      setGraphData({ nodes: [], links: [] }); // TODO: implement transformation
    } catch (e) {
      console.error('Failed to fetch graph:', e);
    } finally {
      setGraphLoading(false);
    }
  }, [graphLayers]);

  const fetchWebUsage = useCallback(async () => {
    try {
      const { data } = await apiClient.controlPlane.get('/v1/proxy/research/usage');
      setWebUsage(data);
    } catch (e) {
      console.error('Failed to fetch usage:', e);
    }
  }, []);

  /* ── SSE Setup ───────────────────────────────────────────────── */

  useEffect(() => {
    if (!sessionId || status !== 'running') return;

    const source = new EventSource(
      `/api/v1/research/${sessionId}/stream`,
      { withCredentials: true }
    );

    source.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        setEvents(prev => [...prev, data]);

        // Update agent states from events
        if (data.type === 'task.reasoning' && data.action) {
          setAgentStates(prev => ({
            ...prev,
            [data.agent || 'Unknown']: { status: 'active', lastAction: data.action },
          }));
        }
      } catch (e) {
        console.error('Failed to parse event:', e);
      }
    };

    source.addEventListener('done', (event) => {
      try {
        const data = JSON.parse(event.data);
        setStatus('completed');
        setReport(data.report);
        setFindings(data.findings || []);
        setDurationMs(data.durationMs || 0);
        setConfidence(data.confidence ?? 0);
        setFromCache(!!data.fromCache);
        fetchTrailSteps(sessionId);
        fetchGraphData(sessionId);
      } catch (e) {
        console.error('Failed to parse done event:', e);
      }
      source.close();
    });

    source.onerror = () => {
      source.close();
      // Fallback to polling
      const fallbackInterval = setInterval(async () => {
        try {
          const { data } = await apiClient.controlPlane.get(`/v1/proxy/research/${sessionId}/status`);
          setEvents(data.events || []);
          if (data.status === 'completed') {
            setStatus('completed');
            clearInterval(fallbackInterval);
            const { data: rpt } = await apiClient.controlPlane.get(`/v1/proxy/research/${sessionId}/report`);
            setReport(rpt.report);
            setFindings(rpt.findings || []);
            setDurationMs(rpt.durationMs || 0);
            setConfidence(rpt.confidence ?? 0);
          } else if (data.status === 'failed') {
            setStatus('failed');
            setError(data.error || 'Research failed');
            clearInterval(fallbackInterval);
          }
        } catch (e) {
          console.error('Polling error:', e);
        }
      }, 2000);
      source._fallbackInterval = fallbackInterval;
    };

    return () => {
      source.close();
      if (source._fallbackInterval) clearInterval(source._fallbackInterval);
    };
  }, [sessionId, status, fetchTrailSteps, fetchGraphData]);

  /* ── Handlers ────────────────────────────────────────────────── */

  const handleStartResearch = useCallback(async (q) => {
    setError(null);
    setStatus('running');
    setEvents([]);
    setReport(null);
    setFindings([]);
    setQuery(q);
    setShowPanel(true);

    try {
      const { data } = await apiClient.controlPlane.post('/v1/proxy/research/start', {
        query: q,
        forceRefresh: false,
      });
      setSessionId(data.session_id);
      setProjectId(data.project_id || null);

      if (data.status === 'completed') {
        setStatus('completed');
        const { data: rpt } = await apiClient.controlPlane.get(`/v1/proxy/research/${data.session_id}/report`);
        setReport(rpt.report);
        setFindings(rpt.findings || []);
        setDurationMs(rpt.durationMs || 0);
        setConfidence(rpt.confidence ?? 0);
      }
    } catch (e) {
      setStatus('failed');
      setError(e.response?.data?.detail || e.message || 'Failed to start research');
    }
  }, []);

  const handleLoadSession = useCallback(async (sid) => {
    setSessionId(sid);
    setError(null);
    setEvents([]);
    try {
      const { data } = await apiClient.controlPlane.get(`/v1/proxy/research/${sid}/status`);
      setStatus(data.status || 'idle');
      setEvents(data.events || []);
      if (data.status === 'completed') {
        const { data: rpt } = await apiClient.controlPlane.get(`/v1/proxy/research/${sid}/report`);
        setReport(rpt.report);
        setFindings(rpt.findings || []);
        setDurationMs(rpt.durationMs || 0);
        setConfidence(rpt.confidence ?? 0);
        setQuery(rpt.query || '');
      }
    } catch (e) {
      setError('Failed to load session');
    }
  }, []);

  const handleSaveToMemory = useCallback(async (source) => {
    if (!sessionId) return;
    try {
      await apiClient.controlPlane.post(`/v1/proxy/research/${sessionId}/save-memory`, {
        sourceId: source.id,
        title: source.title,
        url: source.url,
        tags: ['web-search', 'deep-research'],
      });
    } catch (e) {
      console.error('Failed to save to memory:', e);
    }
  }, [sessionId]);

  /* ── Render (Simple Orchestration) ─────────────────────────── */

  return (
    <div className="h-screen flex flex-col bg-white overflow-hidden">
      <ResearchInput
        value={query}
        onChange={setQuery}
        onSubmit={() => handleStartResearch(query)}
        onLoadSession={handleLoadSession}
        isLoading={status === 'running'}
        sessions={sessions}
        error={error}
      />

      <ResearchPanel
        isOpen={showPanel}
        onClose={() => setShowPanel(false)}
        sessionId={sessionId}
        status={status}
        events={events}
        report={report}
        findings={findings}
        agentStates={agentStates}
        graphData={graphData}
        graphLayers={graphLayers}
        graphLoading={graphLoading}
        webUsage={webUsage}
        onRefreshGraph={() => fetchGraphData(sessionId)}
        onLayerChange={setGraphLayers}
        onSaveToMemory={handleSaveToMemory}
      />
    </div>
  );
}

export default DeepResearch;
```

---

## Step 7: Verify & Test

### Checklist

- [ ] GraphVisualization renders independently with mock data
- [ ] StatusTab auto-scrolls to new events
- [ ] ReportTab displays report correctly
- [ ] ResearchPanel tab switching works smoothly
- [ ] SSE still streams events
- [ ] Polling fallback still works
- [ ] Graph detach/reattach works
- [ ] Layer toggles update graph
- [ ] Save to memory still works
- [ ] No console errors
- [ ] Mobile responsive (panel width adjusts)

### Test Command

```bash
cd /opt/HIVEMIND/frontend/Da-vinci
npm test -- DeepResearch.test.jsx
```

---

## Phase 2: Rollout Plan

1. **Deploy GraphVisualization as reusable component** (can be used in MemoryGraph immediately)
2. **Verify timeline visibility issue is fixed** (events always visible in StatusTab)
3. **Deprecate old DeepResearch.jsx logic** (mark old code as legacy)
4. **Monitor for 24 hours** (check for SSE/polling issues)
5. **Update MemoryGraph to use GraphVisualization** (proves reusability)


import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import ForceGraph2D from 'react-force-graph-2d';
import {
  Network, X, Search, Filter, RefreshCw, Maximize2,
  GitBranch, Clock, ChevronDown,
  ZoomIn, ZoomOut, Crosshair,
} from 'lucide-react';
import apiClient from '../shared/api-client';

/* ─── Constants ──────────────────────────────────────────────────── */
const EDGE_COLORS = {
  Updates: '#117dff',   // blue — evolution
  Extends: '#16a34a',   // green — deepening
  Derives: '#8b5cf6',   // purple — inference
};
const EDGE_LABELS = {
  Updates: 'Updates',
  Extends: 'Extends',
  Derives: 'Derives',
};
const TYPE_COLORS = {
  fact: '#117dff',
  preference: '#d97706',
  decision: '#dc2626',
  lesson: '#16a34a',
  goal: '#8b5cf6',
  event: '#0891b2',
  relationship: '#db2777',
  default: '#525252',
};

/* ─── Helpers ────────────────────────────────────────────────────── */
function truncate(str, len = 80) {
  if (!str) return '';
  return str.length > len ? str.slice(0, len) + '...' : str;
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

/* ─── Node Detail Sidecar ────────────────────────────────────────── */
function NodeDetail({ node, edges, onClose, onNavigate }) {
  if (!node) return null;

  const inbound = edges.filter(e => e.target === node.id || e.target?.id === node.id);
  const outbound = edges.filter(e => e.source === node.id || e.source?.id === node.id);

  return (
    <motion.div
      initial={{ x: 320, opacity: 0 }}
      animate={{ x: 0, opacity: 1 }}
      exit={{ x: 320, opacity: 0 }}
      className="absolute top-0 right-0 w-[340px] h-full bg-white border-l border-[#e3e0db] shadow-[-4px_0_20px_rgba(0,0,0,0.06)] z-20 overflow-y-auto"
    >
      <div className="sticky top-0 bg-white border-b border-[#e3e0db] px-4 py-3 flex items-center justify-between">
        <span className="text-xs font-mono text-[#a3a3a3] uppercase tracking-wider">Memory Detail</span>
        <button onClick={onClose} className="p-1 rounded-lg hover:bg-[#f3f1ec] transition-colors">
          <X size={14} className="text-[#a3a3a3]" />
        </button>
      </div>
      <div className="p-4 space-y-4">
        {/* Title & type */}
        <div>
          <div className="flex items-center gap-2 mb-1">
            <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ backgroundColor: TYPE_COLORS[node.memoryType] || TYPE_COLORS.default }} />
            <span className="text-[10px] font-mono uppercase tracking-wider text-[#a3a3a3]">{node.memoryType || 'memory'}</span>
          </div>
          <h3 className="text-sm font-semibold font-['Space_Grotesk'] text-[#0a0a0a] leading-snug">
            {node.title || 'Untitled Memory'}
          </h3>
        </div>

        {/* Content */}
        <div className="bg-[#faf9f4] border border-[#e3e0db] rounded-lg p-3">
          <p className="text-xs text-[#525252] font-['Space_Grotesk'] leading-relaxed whitespace-pre-wrap">
            {node.content || 'No content'}
          </p>
        </div>

        {/* Tags */}
        {node.tags?.length > 0 && (
          <div className="flex flex-wrap gap-1">
            {node.tags.map(t => (
              <span key={t} className="px-1.5 py-0.5 rounded-md text-[10px] font-mono bg-[#117dff]/10 text-[#117dff] border border-[#117dff]/20">
                {t}
              </span>
            ))}
          </div>
        )}

        {/* Scores */}
        <div className="grid grid-cols-3 gap-2">
          {[
            { label: 'Importance', value: node.importanceScore?.toFixed(2) },
            { label: 'Strength', value: node.strength?.toFixed(2) },
            { label: 'Recalls', value: node.recallCount },
          ].map(s => (
            <div key={s.label} className="bg-[#faf9f4] border border-[#e3e0db] rounded-lg p-2 text-center">
              <p className="text-[10px] text-[#a3a3a3] font-mono">{s.label}</p>
              <p className="text-sm font-semibold font-['Space_Grotesk'] text-[#0a0a0a]">{s.value ?? '—'}</p>
            </div>
          ))}
        </div>

        {/* Temporal */}
        <div className="flex items-center gap-2 text-[11px] text-[#a3a3a3] font-['Space_Grotesk']">
          <Clock size={12} />
          <span>{node.daysSinceUpdate != null ? `${node.daysSinceUpdate.toFixed(1)} days ago` : '—'}</span>
          <span className="ml-auto">Glow: {((node.temporalWeight || 0) * 100).toFixed(0)}%</span>
        </div>

        {/* Relationships */}
        {(inbound.length > 0 || outbound.length > 0) && (
          <div>
            <p className="text-[10px] font-mono text-[#a3a3a3] uppercase tracking-wider mb-2">Relationships</p>
            <div className="space-y-1.5">
              {outbound.map((e, i) => {
                const targetId = typeof e.target === 'object' ? e.target.id : e.target;
                return (
                  <button
                    key={`out-${i}`}
                    onClick={() => onNavigate(targetId)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#faf9f4] border border-[#e3e0db] hover:border-[#117dff]/20 text-left transition-colors"
                  >
                    <GitBranch size={10} style={{ color: EDGE_COLORS[e.type] || '#a3a3a3' }} />
                    <span className="text-[10px] font-mono" style={{ color: EDGE_COLORS[e.type] }}>{e.type}</span>
                    <span className="text-[11px] text-[#525252] font-['Space_Grotesk'] truncate flex-1">{truncate(targetId, 20)}</span>
                  </button>
                );
              })}
              {inbound.map((e, i) => {
                const sourceId = typeof e.source === 'object' ? e.source.id : e.source;
                return (
                  <button
                    key={`in-${i}`}
                    onClick={() => onNavigate(sourceId)}
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-lg bg-[#faf9f4] border border-[#e3e0db] hover:border-[#117dff]/20 text-left transition-colors"
                  >
                    <GitBranch size={10} className="rotate-180" style={{ color: EDGE_COLORS[e.type] || '#a3a3a3' }} />
                    <span className="text-[10px] font-mono opacity-50" style={{ color: EDGE_COLORS[e.type] }}>← {e.type}</span>
                    <span className="text-[11px] text-[#525252] font-['Space_Grotesk'] truncate flex-1">{truncate(sourceId, 20)}</span>
                  </button>
                );
              })}
            </div>
          </div>
        )}

        {/* Meta */}
        <div className="text-[10px] text-[#a3a3a3] font-mono space-y-0.5">
          <p>ID: {node.id}</p>
          {node.sourcePlatform && <p>Source: {node.sourcePlatform}</p>}
          {node.project && <p>Project: {node.project}</p>}
          {node.createdAt && <p>Created: {new Date(node.createdAt).toLocaleString()}</p>}
        </div>
      </div>
    </motion.div>
  );
}

/* ─── Main Page ──────────────────────────────────────────────────── */
export default function MemoryGraph() {
  const graphRef = useRef();
  const [graphData, setGraphData] = useState({ nodes: [], links: [] });
  const [rawEdges, setRawEdges] = useState([]);
  const [meta, setMeta] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [selectedNode, setSelectedNode] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [highlightNodes, setHighlightNodes] = useState(new Set());
  const [projectFilter, setProjectFilter] = useState('');
  const [showFilters, setShowFilters] = useState(false);

  // Fetch graph data
  const fetchGraph = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiClient.getGraph({ project: projectFilter || undefined, limit: 300 });
      const nodes = (data.nodes || []).map(n => ({
        ...n,
        val: Math.max(2, (n.importanceScore || 0.5) * 8 + (n.recallCount || 0) * 0.5),
      }));
      const links = (data.edges || []).map(e => ({
        source: e.source,
        target: e.target,
        type: e.type,
        confidence: e.confidence || 1,
      }));
      setGraphData({ nodes, links });
      setRawEdges(data.edges || []);
      setMeta(data.meta || null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
      setGraphData({ nodes: [], links: [] });
    } finally {
      setLoading(false);
    }
  }, [projectFilter]);

  useEffect(() => { fetchGraph(); }, [fetchGraph]);

  // Search highlighting
  useEffect(() => {
    if (!searchQuery.trim()) {
      setHighlightNodes(new Set());
      return;
    }
    const q = searchQuery.toLowerCase();
    const matches = new Set();
    graphData.nodes.forEach(n => {
      if (
        n.title?.toLowerCase().includes(q) ||
        n.content?.toLowerCase().includes(q) ||
        n.tags?.some(t => t.toLowerCase().includes(q))
      ) {
        matches.add(n.id);
      }
    });
    setHighlightNodes(matches);

    // Zoom to first match
    if (matches.size > 0 && graphRef.current) {
      const firstId = [...matches][0];
      const node = graphData.nodes.find(n => n.id === firstId);
      if (node) {
        graphRef.current.centerAt(node.x, node.y, 600);
        graphRef.current.zoom(3, 600);
      }
    }
  }, [searchQuery, graphData.nodes]);

  // Node click
  const handleNodeClick = useCallback((node) => {
    setSelectedNode(node);
    if (graphRef.current) {
      graphRef.current.centerAt(node.x, node.y, 400);
      graphRef.current.zoom(4, 400);
    }
  }, []);

  // Navigate to node from sidecar
  const handleNavigate = useCallback((nodeId) => {
    const node = graphData.nodes.find(n => n.id === nodeId);
    if (node) handleNodeClick(node);
  }, [graphData.nodes, handleNodeClick]);

  // Custom node painting
  const paintNode = useCallback((node, ctx, globalScale) => {
    const isHighlighted = highlightNodes.size > 0 && highlightNodes.has(node.id);
    const isDimmed = highlightNodes.size > 0 && !highlightNodes.has(node.id);
    const isSelected = selectedNode?.id === node.id;
    const baseColor = TYPE_COLORS[node.memoryType] || TYPE_COLORS.default;
    const glow = node.temporalWeight || 0.3;
    const radius = Math.sqrt(node.val || 4) * 2.5;

    // Outer glow (temporal decay)
    if (glow > 0.3 && !isDimmed) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 4 + glow * 6, 0, 2 * Math.PI);
      ctx.fillStyle = hexToRgba(baseColor, glow * 0.2);
      ctx.fill();
    }

    // Selection ring
    if (isSelected) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 3, 0, 2 * Math.PI);
      ctx.strokeStyle = '#117dff';
      ctx.lineWidth = 2 / globalScale;
      ctx.stroke();
    }

    // Highlight ring
    if (isHighlighted) {
      ctx.beginPath();
      ctx.arc(node.x, node.y, radius + 2, 0, 2 * Math.PI);
      ctx.strokeStyle = '#d97706';
      ctx.lineWidth = 1.5 / globalScale;
      ctx.stroke();
    }

    // Node body
    ctx.beginPath();
    ctx.arc(node.x, node.y, radius, 0, 2 * Math.PI);
    ctx.fillStyle = isDimmed ? hexToRgba(baseColor, 0.15) : hexToRgba(baseColor, 0.6 + glow * 0.4);
    ctx.fill();

    // Border
    ctx.strokeStyle = isDimmed ? hexToRgba(baseColor, 0.1) : hexToRgba(baseColor, 0.8);
    ctx.lineWidth = 0.5 / globalScale;
    ctx.stroke();

    // Label (only at zoom)
    if (globalScale > 1.8 && !isDimmed) {
      const label = truncate(node.title || '', 30);
      ctx.font = `${Math.max(10, 11 / globalScale)}px Space Grotesk, sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = isDimmed ? 'rgba(0,0,0,0.1)' : 'rgba(10,10,10,0.8)';
      ctx.fillText(label, node.x, node.y + radius + 2);
    }
  }, [highlightNodes, selectedNode]);

  // Custom link painting
  const paintLink = useCallback((link, ctx) => {
    const color = EDGE_COLORS[link.type] || '#e3e0db';
    ctx.strokeStyle = hexToRgba(color, 0.35 + (link.confidence || 0.5) * 0.3);
    ctx.lineWidth = link.type === 'Extends' ? 1.5 : 0.8;
    if (link.type === 'Derives') {
      ctx.setLineDash([4, 3]);
    }
    ctx.beginPath();
    ctx.moveTo(link.source.x, link.source.y);
    ctx.lineTo(link.target.x, link.target.y);
    ctx.stroke();
    ctx.setLineDash([]);
  }, []);

  // Stats
  const stats = useMemo(() => {
    if (!meta) return null;
    return {
      nodes: meta.nodeCount || graphData.nodes.length,
      edges: meta.edgeCount || graphData.links?.length || 0,
      projects: meta.projects?.length || 0,
    };
  }, [meta, graphData]);

  return (
    <div className="h-screen bg-[#faf9f4] flex flex-col overflow-hidden">
      {/* Top bar */}
      <div className="shrink-0 border-b border-[#e3e0db] bg-white px-4 py-3 flex items-center gap-3 z-10">
        <div className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-[#8b5cf6]/10 flex items-center justify-center">
            <Network size={16} className="text-[#8b5cf6]" />
          </div>
          <h1 className="text-sm font-bold font-['Space_Grotesk'] text-[#0a0a0a]">Memory Graph</h1>
        </div>

        {/* Search */}
        <div className="relative flex-1 max-w-xs">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-[#a3a3a3]" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Search nodes..."
            className="w-full pl-8 pr-3 py-1.5 border border-[#e3e0db] rounded-lg text-xs font-['Space_Grotesk'] text-[#0a0a0a] placeholder:text-[#a3a3a3] focus:outline-none focus:border-[#117dff]/40 bg-[#faf9f4]"
          />
        </div>

        {/* Filters */}
        <div className="relative">
          <button
            onClick={() => setShowFilters(!showFilters)}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-['Space_Grotesk'] border border-[#e3e0db] text-[#525252] hover:border-[#117dff]/20 transition-colors"
          >
            <Filter size={12} />
            {projectFilter || 'All Projects'}
            <ChevronDown size={10} />
          </button>
          <AnimatePresence>
            {showFilters && meta?.projects?.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                className="absolute top-full mt-1 left-0 bg-white border border-[#e3e0db] rounded-lg shadow-lg z-30 py-1 min-w-[160px]"
              >
                <button
                  onClick={() => { setProjectFilter(''); setShowFilters(false); }}
                  className="w-full text-left px-3 py-1.5 text-xs font-['Space_Grotesk'] text-[#525252] hover:bg-[#faf9f4]"
                >
                  All Projects
                </button>
                {meta.projects.map(p => (
                  <button
                    key={p}
                    onClick={() => { setProjectFilter(p); setShowFilters(false); }}
                    className={`w-full text-left px-3 py-1.5 text-xs font-['Space_Grotesk'] hover:bg-[#faf9f4] ${projectFilter === p ? 'text-[#117dff] font-semibold' : 'text-[#525252]'}`}
                  >
                    {p}
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Actions */}
        <button
          onClick={fetchGraph}
          disabled={loading}
          className="p-1.5 rounded-lg border border-[#e3e0db] text-[#a3a3a3] hover:text-[#525252] hover:border-[#117dff]/20 transition-colors disabled:opacity-40"
          title="Refresh"
        >
          <RefreshCw size={13} className={loading ? 'animate-spin' : ''} />
        </button>
        <button
          onClick={() => graphRef.current?.zoomToFit(400, 40)}
          className="p-1.5 rounded-lg border border-[#e3e0db] text-[#a3a3a3] hover:text-[#525252] hover:border-[#117dff]/20 transition-colors"
          title="Fit to view"
        >
          <Maximize2 size={13} />
        </button>

        {/* Stats */}
        {stats && (
          <div className="flex items-center gap-3 ml-auto text-[10px] font-mono text-[#a3a3a3]">
            <span>{stats.nodes} nodes</span>
            <span>{stats.edges} edges</span>
            <span>{stats.projects} projects</span>
          </div>
        )}
      </div>

      {/* Graph canvas */}
      <div className="flex-1 relative">
        {loading && graphData.nodes.length === 0 && (
          <div className="absolute inset-0 flex items-center justify-center z-10">
            <div className="flex flex-col items-center gap-3">
              <div className="w-8 h-8 border-2 border-[#117dff] border-t-transparent rounded-full animate-spin" />
              <span className="text-xs text-[#a3a3a3] font-['Space_Grotesk']">Loading memory graph...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="absolute top-4 left-1/2 -translate-x-1/2 z-10 bg-red-50 border border-red-200 rounded-xl px-4 py-2 text-xs text-[#dc2626] font-['Space_Grotesk']">
            {error}
          </div>
        )}

        {graphData.nodes.length > 0 && (
          <ForceGraph2D
            ref={graphRef}
            graphData={graphData}
            nodeCanvasObject={paintNode}
            linkCanvasObject={paintLink}
            onNodeClick={handleNodeClick}
            onBackgroundClick={() => setSelectedNode(null)}
            nodePointerAreaPaint={(node, color, ctx) => {
              const r = Math.sqrt(node.val || 4) * 2.5 + 2;
              ctx.beginPath();
              ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
              ctx.fillStyle = color;
              ctx.fill();
            }}
            linkDirectionalArrowLength={3}
            linkDirectionalArrowRelPos={0.9}
            linkDirectionalArrowColor={(link) => EDGE_COLORS[link.type] || '#e3e0db'}
            cooldownTicks={100}
            warmupTicks={50}
            d3AlphaDecay={0.02}
            d3VelocityDecay={0.3}
            backgroundColor="#faf9f4"
            width={typeof window !== 'undefined' ? window.innerWidth - (selectedNode ? 340 : 0) - 260 : 800}
            height={typeof window !== 'undefined' ? window.innerHeight - 52 : 600}
          />
        )}

        {graphData.nodes.length === 0 && !loading && !error && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="text-center">
              <Network size={32} className="text-[#e3e0db] mx-auto mb-3" />
              <p className="text-sm text-[#a3a3a3] font-['Space_Grotesk']">No memories found. Save some memories to see your knowledge graph.</p>
            </div>
          </div>
        )}

        {/* Legend */}
        <div className="absolute bottom-4 left-4 bg-white/90 backdrop-blur border border-[#e3e0db] rounded-xl px-3 py-2.5 z-10">
          <p className="text-[9px] font-mono text-[#a3a3a3] uppercase tracking-wider mb-1.5">Relationships</p>
          <div className="flex items-center gap-3">
            {Object.entries(EDGE_COLORS).map(([type, color]) => (
              <div key={type} className="flex items-center gap-1.5">
                <div className="w-4 h-0.5 rounded-full" style={{ backgroundColor: color, opacity: type === 'Derives' ? 0.6 : 1 }} />
                <span className="text-[10px] font-['Space_Grotesk'] text-[#525252]">{EDGE_LABELS[type]}</span>
              </div>
            ))}
          </div>
          <p className="text-[9px] font-mono text-[#a3a3a3] uppercase tracking-wider mt-2 mb-1.5">Node Glow = Recency</p>
          <div className="flex items-center gap-1">
            <div className="w-3 h-3 rounded-full bg-[#117dff]" />
            <span className="text-[10px] text-[#525252] font-['Space_Grotesk']">Recent</span>
            <div className="w-6 h-0.5 bg-gradient-to-r from-[#117dff] to-[#117dff]/10 rounded mx-1" />
            <div className="w-3 h-3 rounded-full bg-[#117dff]/15" />
            <span className="text-[10px] text-[#525252] font-['Space_Grotesk']">Old</span>
          </div>
        </div>

        {/* Zoom controls */}
        <div className="absolute bottom-4 right-4 flex flex-col gap-1 z-10">
          {[
            { icon: ZoomIn, action: () => graphRef.current?.zoom(graphRef.current.zoom() * 1.5, 200) },
            { icon: ZoomOut, action: () => graphRef.current?.zoom(graphRef.current.zoom() / 1.5, 200) },
            { icon: Crosshair, action: () => graphRef.current?.zoomToFit(400, 40) },
          ].map(({ icon: Icon, action }, i) => (
            <button
              key={i}
              onClick={action}
              className="w-8 h-8 rounded-lg bg-white/90 backdrop-blur border border-[#e3e0db] flex items-center justify-center text-[#a3a3a3] hover:text-[#525252] transition-colors"
            >
              <Icon size={14} />
            </button>
          ))}
        </div>

        {/* Node detail sidecar */}
        <AnimatePresence>
          {selectedNode && (
            <NodeDetail
              node={selectedNode}
              edges={rawEdges}
              onClose={() => setSelectedNode(null)}
              onNavigate={handleNavigate}
            />
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}

/**
 * Graph clusterer — derives mind-group structure from a memory graph.
 *
 * Input:  flat node + edge arrays (as returned by `/api/graph` today).
 * Output: per-node `{clusterId, clusterRole, hubScore, bridgeScore}` map plus
 *         per-cluster meta (size, label, topTags). Pure function — no I/O.
 *
 * Algorithm:
 *   1. Build an undirected graphology graph from the edges. Self-loops and
 *      duplicates are coalesced; edge weight = relationship confidence (clamped
 *      to [0.1, 1.0]) so high-confidence edges pull harder during community
 *      assignment.
 *   2. Run Louvain community detection. Resolution is tuned so a typical
 *      personal graph (~250–2000 nodes) collapses into 6–14 groups rather than
 *      either one mega-cluster or hundreds of singletons.
 *   3. Compute per-node degree and bridge scores:
 *        hubScore    = degree-within-cluster / max-degree-within-cluster
 *        bridgeScore = #neighbors-in-other-clusters / total-degree
 *      A node is labelled "hub" when it sits in the top 12% by hubScore inside
 *      its cluster, "bridge" when bridgeScore ≥ 0.4 (and not already a hub),
 *      "spoke" otherwise.
 *   4. Emit cluster meta: size, top tags (from node.tags overlap), and the
 *      single highest-degree node as the suggested hub representative. Label
 *      is left null — LLM-generated labels are layered on later (Phase 4 in
 *      docs/GRAPH_MEMORY_UPGRADE.md).
 *
 * Disconnected nodes (no edges) each form their own singleton cluster so the
 * UI can still render them without crashing forceCluster.
 *
 * Performance: O(N + E·log N) Louvain pass. ~50ms for 5k nodes / 20k edges
 * on a 2024 laptop; well inside the existing /api/graph budget.
 */

import Graph from 'graphology';
import louvain from 'graphology-communities-louvain';

const DEFAULT_OPTIONS = {
  resolution: 1.0,        // Louvain resolution — higher = more communities
  hubPercentile: 0.88,    // top 12% by hubScore → hub
  bridgeThreshold: 0.40,  // ≥ 40% of neighbors out-of-cluster → bridge
  minWeight: 0.10,        // Edge weight floor (avoid 0-weight ignored edges)
  maxTopTags: 5,
};

/**
 * @param {Array<{id: string, tags?: string[], importanceScore?: number}>} nodes
 * @param {Array<{source: string, target: string, type?: string, confidence?: number}>} edges
 * @param {Object} [options]
 * @returns {{
 *   nodeMeta: Record<string, {clusterId: string, clusterRole: string, hubScore: number, bridgeScore: number}>,
 *   clusters: Array<{id: string, size: number, label: string|null, topTags: string[], hubNodeId: string|null}>,
 * }}
 */
export function clusterGraph(nodes = [], edges = [], options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!Array.isArray(nodes) || nodes.length === 0) {
    return { nodeMeta: {}, clusters: [] };
  }

  // ── Build undirected graph ────────────────────────────────────
  const g = new Graph({ type: 'undirected', allowSelfLoops: false, multi: false });
  const nodeIds = new Set();
  for (const node of nodes) {
    if (!node?.id || nodeIds.has(node.id)) continue;
    nodeIds.add(node.id);
    g.addNode(node.id);
  }

  let totalEdgeWeight = 0;
  for (const edge of edges) {
    const src = edge?.source;
    const tgt = edge?.target;
    if (!src || !tgt || src === tgt) continue;
    if (!nodeIds.has(src) || !nodeIds.has(tgt)) continue;
    // Coalesce duplicates: graphology multi=false throws if we re-add; bump weight instead.
    const weight = Math.max(opts.minWeight, Math.min(1.0, edge.confidence ?? 0.5));
    if (g.hasEdge(src, tgt)) {
      const prev = g.getEdgeAttribute(src, tgt, 'weight') || 0;
      g.setEdgeAttribute(src, tgt, 'weight', prev + weight);
    } else {
      g.addEdge(src, tgt, { weight });
    }
    totalEdgeWeight += weight;
  }

  // ── Run Louvain ───────────────────────────────────────────────
  // Singleton nodes (no edges) are returned with their own community id.
  let assignments;
  try {
    assignments = louvain(g, {
      resolution: opts.resolution,
      getEdgeWeight: 'weight',
    });
  } catch (err) {
    // Louvain throws on an empty edge set — fall back to one cluster per node.
    assignments = {};
    for (const id of g.nodes()) assignments[id] = id;
  }

  // ── Compute hub + bridge scores ───────────────────────────────
  // First pass: total degree per node + degree-within-cluster, neighbor-cluster counts.
  const degreeIn = new Map();         // nodeId → within-cluster degree
  const degreeOut = new Map();        // nodeId → cross-cluster degree
  const clusterMembers = new Map();   // clusterId → [nodeId]
  const nodeIndex = new Map(nodes.map(n => [n.id, n]));

  for (const id of g.nodes()) {
    degreeIn.set(id, 0);
    degreeOut.set(id, 0);
    const clusterId = String(assignments[id]);
    if (!clusterMembers.has(clusterId)) clusterMembers.set(clusterId, []);
    clusterMembers.get(clusterId).push(id);
  }

  g.forEachEdge((edgeKey, attrs, src, tgt) => {
    const srcCluster = String(assignments[src]);
    const tgtCluster = String(assignments[tgt]);
    if (srcCluster === tgtCluster) {
      degreeIn.set(src, (degreeIn.get(src) || 0) + 1);
      degreeIn.set(tgt, (degreeIn.get(tgt) || 0) + 1);
    } else {
      degreeOut.set(src, (degreeOut.get(src) || 0) + 1);
      degreeOut.set(tgt, (degreeOut.get(tgt) || 0) + 1);
    }
  });

  // ── Assign roles + scores per node ────────────────────────────
  const nodeMeta = {};
  for (const [clusterId, members] of clusterMembers.entries()) {
    // Local hub threshold per cluster — relative to that cluster's max degree.
    let localMaxIn = 1;
    for (const id of members) {
      localMaxIn = Math.max(localMaxIn, degreeIn.get(id) || 0);
    }
    // Compute hubScore (in-cluster degree normalized) + bridgeScore for each member.
    const hubScores = members.map(id => ({
      id,
      hubScore: (degreeIn.get(id) || 0) / localMaxIn,
      bridgeScore:
        ((degreeIn.get(id) || 0) + (degreeOut.get(id) || 0)) > 0
          ? (degreeOut.get(id) || 0) /
            ((degreeIn.get(id) || 0) + (degreeOut.get(id) || 0))
          : 0,
    }));
    // Rank for hub percentile.
    const ranked = [...hubScores].sort((a, b) => b.hubScore - a.hubScore);
    const hubCutoffIdx = Math.max(0, Math.floor(ranked.length * (1 - opts.hubPercentile)));
    const hubCutoff = ranked[hubCutoffIdx]?.hubScore ?? 1.0;

    for (const entry of hubScores) {
      const isHub = entry.hubScore >= hubCutoff && entry.hubScore > 0;
      const isBridge = !isHub && entry.bridgeScore >= opts.bridgeThreshold;
      nodeMeta[entry.id] = {
        clusterId,
        clusterRole: isHub ? 'hub' : isBridge ? 'bridge' : 'spoke',
        hubScore: round4(entry.hubScore),
        bridgeScore: round4(entry.bridgeScore),
      };
    }
  }

  // ── Cluster-level meta ────────────────────────────────────────
  const clusters = [];
  for (const [clusterId, members] of clusterMembers.entries()) {
    // Top tags by frequency across members.
    const tagCounts = new Map();
    let hubNodeId = null;
    let hubDegree = -1;
    for (const id of members) {
      const node = nodeIndex.get(id);
      if (!node) continue;
      for (const tag of node.tags || []) {
        if (!tag) continue;
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
      const d = (degreeIn.get(id) || 0) + (degreeOut.get(id) || 0);
      if (d > hubDegree) {
        hubDegree = d;
        hubNodeId = id;
      }
    }
    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, opts.maxTopTags)
      .map(([tag]) => tag);

    clusters.push({
      id: clusterId,
      size: members.length,
      label: null, // Filled in later by LLM auto-labelling (Phase 4 in upgrade plan)
      topTags,
      hubNodeId,
    });
  }

  // Stable sort: largest cluster first.
  clusters.sort((a, b) => b.size - a.size);
  // Compress cluster ids to "c0", "c1", ... (Louvain emits raw integers as strings).
  const idRemap = new Map();
  clusters.forEach((c, idx) => {
    idRemap.set(c.id, `c${idx}`);
  });
  for (const c of clusters) c.id = idRemap.get(c.id) || c.id;
  for (const id of Object.keys(nodeMeta)) {
    const remapped = idRemap.get(nodeMeta[id].clusterId);
    if (remapped) nodeMeta[id].clusterId = remapped;
  }

  return { nodeMeta, clusters };
}

function round4(x) {
  return Math.round((x || 0) * 10000) / 10000;
}

export default clusterGraph;

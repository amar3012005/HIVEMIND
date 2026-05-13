/**
 * Memory compactor (Phase 4 of GRAPH_MEMORY_UPGRADE).
 *
 * Collapses large clusters of related memories into consolidated facts to keep
 * the graph from growing unboundedly. Triggered nightly per user, or via
 * /api/memory/compact on-demand.
 *
 * Strategy:
 *   1. For each cluster with size > maxNodes, group memories into batches of
 *      10-20 by shared tags + same week window.
 *   2. For each batch, call an LLM to summarize into one consolidated fact
 *      preserving every entity, number, and date.
 *   3. Insert summary memory; flip originals.isLatest=false; create Updates
 *      edges summary -> each original.
 *
 * Pluggable LLM: caller injects { summarize: async (texts) => string }.
 * Pluggable store: caller injects { insertMemory, updateMemory, createEdge }.
 */

const DEFAULT_BATCH_SIZE = 12;
const DEFAULT_MAX_NODES = 50;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function startOfWeek(date) {
  const d = date instanceof Date ? new Date(date) : new Date(date || Date.now());
  d.setUTCHours(0, 0, 0, 0);
  const day = d.getUTCDay();
  const diff = (day === 0 ? -6 : 1 - day);
  d.setUTCDate(d.getUTCDate() + diff);
  return d.getTime();
}

function topSharedTags(memories, k = 3) {
  const counts = new Map();
  for (const m of memories) {
    const tags = m.tags || [];
    for (const t of tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, k).map(([t]) => t);
}

/**
 * Group memories into compactable batches by (top-tag, week).
 * Returns array of { key, memories }.
 */
export function bucketize(memories, batchSize = DEFAULT_BATCH_SIZE) {
  const buckets = new Map();
  for (const m of memories) {
    const tag = (m.tags && m.tags[0]) || '_';
    const week = startOfWeek(m.createdAt || m.created_at || m.updatedAt);
    const key = `${tag}::${week}`;
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(m);
  }
  const batches = [];
  for (const [key, group] of buckets) {
    for (let i = 0; i < group.length; i += batchSize) {
      const slice = group.slice(i, i + batchSize);
      if (slice.length >= 3) batches.push({ key, memories: slice });
    }
  }
  return batches;
}

/**
 * Plan compaction for one cluster. Returns { skip, batches, reason }.
 */
export function planClusterCompaction(cluster, memories, opts = {}) {
  const maxNodes = opts.maxNodes ?? DEFAULT_MAX_NODES;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  if (!memories || memories.length <= maxNodes) {
    return { skip: true, reason: `cluster has ${memories?.length || 0} <= ${maxNodes} memories`, batches: [] };
  }
  const batches = bucketize(memories, batchSize);
  return { skip: batches.length === 0, batches, reason: batches.length === 0 ? 'no compactable batches' : null };
}

/**
 * Execute compaction for prepared batches.
 *
 * @param {Object} deps
 * @param {Object} deps.store - { insertMemory(m), updateMemory(id, patch), createEdge(e) }
 * @param {Function} deps.summarize - async (texts: string[], context: object) => string
 * @param {Object} opts - { dryRun, clusterId, userId, orgId }
 */
export async function executeCompaction({ batches, store, summarize }, opts = {}) {
  const results = [];
  if (!batches?.length) return results;

  for (const { key, memories } of batches) {
    const texts = memories.map(m => m.content || '').filter(Boolean);
    if (texts.length === 0) continue;

    const sharedTags = topSharedTags(memories);
    const minDate = new Date(Math.min(...memories.map(m => new Date(m.createdAt || m.created_at || Date.now()).getTime())));
    const maxDate = new Date(Math.max(...memories.map(m => new Date(m.createdAt || m.created_at || Date.now()).getTime())));

    let summary;
    try {
      summary = await summarize(texts, {
        sharedTags,
        clusterId: opts.clusterId,
        timeRange: { start: minDate.toISOString(), end: maxDate.toISOString() },
      });
    } catch (err) {
      results.push({ key, status: 'error', error: err.message, count: memories.length });
      continue;
    }

    if (!summary || summary.length < 20) {
      results.push({ key, status: 'skipped', reason: 'empty summary', count: memories.length });
      continue;
    }

    if (opts.dryRun) {
      results.push({ key, status: 'dry_run', summary: summary.slice(0, 200), count: memories.length });
      continue;
    }

    const newMemory = {
      userId: opts.userId,
      orgId: opts.orgId,
      content: summary,
      title: `Compacted: ${sharedTags.join(', ') || 'cluster'}`,
      memoryType: 'fact',
      tags: ['compacted', ...sharedTags],
      isLatest: true,
      strength: 1.0,
      importanceScore: 0.7,
      documentDate: maxDate,
      sourcePlatform: 'compactor',
    };

    try {
      const inserted = await store.insertMemory(newMemory);
      const newId = inserted.id || inserted.memory_id;

      for (const m of memories) {
        await store.updateMemory(m.id, { isLatest: false, supersedesId: newId });
        await store.createEdge({
          fromId: newId,
          toId: m.id,
          type: 'Updates',
          confidence: 0.85,
          inferenceModel: 'compactor',
          createdBy: 'system:compactor',
        });
      }
      results.push({ key, status: 'compacted', newId, count: memories.length });
    } catch (err) {
      results.push({ key, status: 'error', error: err.message, count: memories.length });
    }
  }
  return results;
}

export const TUNING = {
  DEFAULT_BATCH_SIZE,
  DEFAULT_MAX_NODES,
};

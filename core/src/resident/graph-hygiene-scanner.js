import { randomUUID } from 'node:crypto';

// ── Stopwords for Jaccard tokenization ──────────────────────────────────────
const STOPWORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'shall', 'may', 'might', 'can', 'must', 'to', 'of', 'in',
  'for', 'on', 'with', 'at', 'by', 'from', 'as', 'into', 'about',
  'that', 'this', 'these', 'those', 'it', 'its', 'and', 'or', 'but',
  'not', 'no', 'if', 'so', 'than', 'too', 'very', 'just', 'also',
  'then', 'more', 'some', 'any', 'each', 'all', 'both', 'few', 'most',
  'other', 'such', 'only', 'own', 'same', 'there', 'their', 'them',
  'they', 'what', 'which', 'who', 'whom', 'how', 'when', 'where', 'why',
  'her', 'him', 'his', 'she', 'he', 'we', 'our', 'you', 'your', 'my',
  'me', 'up', 'out', 'off', 'over', 'under', 'again', 'once',
]);

const NOISE_PATTERNS = [
  /unsubscribe/i,
  /noreply/i,
  /no-reply/i,
  /click\s+here\s+to\s+unsub/i,
  /opt[\s-]?out/i,
  /manage\s+(your\s+)?subscriptions?/i,
  /email\s+preferences/i,
];

const ARTIFACT_TITLE_PATTERNS = [
  /^TARA Turn\s+\d+/i,
  /^Clinical Insight/i,
  /^Session:\s*/i,
];

const ARTIFACT_TAGS = new Set(['tara-turn', 'tara-insight']);

// ── Tokenizer ───────────────────────────────────────────────────────────────

function tokenize(text = '') {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}

function tokenSet(text) {
  return new Set(tokenize(text));
}

function jaccardSimilarity(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function daysSince(dateStr) {
  if (!dateStr) return Infinity;
  const then = new Date(dateStr);
  const now = new Date();
  return (now - then) / (1000 * 60 * 60 * 24);
}

function preview(content, len = 100) {
  if (!content) return '';
  return content.length > len ? content.slice(0, len) + '...' : content;
}

// ── Scanner ─────────────────────────────────────────────────────────────────

/**
 * GraphHygieneScanner
 *
 * Scans the memory graph for quality issues and generates proposals
 * for user review. Nothing is auto-executed -- all changes require approval.
 *
 * Usage:
 *   const scanner = new GraphHygieneScanner(store);
 *   const report = await scanner.scan(userId, orgId, options);
 *   // report.proposals = [{ id, category, severity, confidence, suggestedAction, reason, memories }]
 *   // User reviews proposals, approves/rejects each
 *   await scanner.executeProposals(approvedProposals, 'merge');
 */
export class GraphHygieneScanner {
  /**
   * @param {import('../memory/prisma-graph-store.js').PrismaGraphStore} store
   */
  constructor(store, prisma) {
    this.store = store;
    this.prisma = prisma || store.client || null;
  }

  /**
   * Full scan of a user's memory graph.
   * @param {string} userId
   * @param {string} orgId
   * @param {Object} options
   * @param {string[]} [options.categories] - which issue types to scan for
   * @param {number}   [options.limit]      - max proposals returned
   * @param {number}   [options.duplicateThreshold] - Jaccard threshold for near-duplicates
   * @returns {Promise<{ proposals: Proposal[], stats: ScanStats }>}
   */
  async scan(userId, orgId, options = {}) {
    const {
      categories = ['duplicates', 'stale', 'noise', 'orphans', 'contradictions', 'artifacts'],
      limit = 500,
      duplicateThreshold = 0.70,
    } = options;

    // Fetch ALL memories for the user (bypass scope filtering for hygiene scan)
    let memories;
    if (this.prisma) {
      // Direct Prisma query — no scope filter, includes all visibility
      const raw = await this.prisma.memory.findMany({
        where: { userId, orgId, deletedAt: null },
        include: { sourceMetadata: true },
        orderBy: { createdAt: 'desc' },
        take: 2000, // cap for performance
      });
      memories = raw.map(r => ({
        id: r.id,
        content: r.content,
        title: r.title,
        tags: r.tags || [],
        memory_type: r.memoryType,
        is_latest: r.isLatest,
        importance_score: r.importanceScore,
        recall_count: r.recallCount || 0,
        created_at: r.createdAt?.toISOString(),
        updated_at: r.updatedAt?.toISOString(),
        source: r.sourceMetadata?.sourcePlatform || null,
        metadata: typeof r.metadata === 'object' ? r.metadata : {},
      }));
    } else {
      memories = await this.store.listLatestMemories({ user_id: userId, org_id: orgId });
    }

    // Also fetch relationships for orphan / contradiction detection
    const relationships = await this.store.listRelationships({
      user_id: userId,
      org_id: orgId,
      limit: 5000,
    });

    const proposals = [];
    const stats = {
      scanned: memories.length,
      relationships: relationships.length,
      issues: 0,
      byCategory: {},
    };

    // Pre-compute token sets once (shared by duplicates + noise)
    const tokenCache = new Map();
    for (const mem of memories) {
      tokenCache.set(mem.id, tokenSet(mem.content));
    }

    if (categories.includes('duplicates')) {
      const found = this._findDuplicates(memories, tokenCache, duplicateThreshold);
      proposals.push(...found);
      stats.byCategory.duplicates = found.length;
    }
    if (categories.includes('noise')) {
      const found = this._findNoise(memories, tokenCache);
      proposals.push(...found);
      stats.byCategory.noise = found.length;
    }
    if (categories.includes('stale')) {
      const found = this._findStale(memories);
      proposals.push(...found);
      stats.byCategory.stale = found.length;
    }
    if (categories.includes('orphans')) {
      const found = this._findOrphans(memories, relationships);
      proposals.push(...found);
      stats.byCategory.orphans = found.length;
    }
    if (categories.includes('artifacts')) {
      const found = this._findArtifacts(memories);
      proposals.push(...found);
      stats.byCategory.artifacts = found.length;
    }
    if (categories.includes('contradictions')) {
      const found = this._findContradictions(memories, relationships);
      proposals.push(...found);
      stats.byCategory.contradictions = found.length;
    }

    // Sort by confidence descending, then severity
    const severityOrder = { high: 0, medium: 1, low: 2 };
    proposals.sort((a, b) => {
      const diff = b.confidence - a.confidence;
      return diff !== 0 ? diff : (severityOrder[a.severity] || 2) - (severityOrder[b.severity] || 2);
    });

    stats.issues = proposals.length;

    return { proposals: proposals.slice(0, limit), stats };
  }

  /**
   * Execute approved proposals.
   * @param {Proposal[]} proposals - approved proposals to execute
   * @param {string} action - override action: 'merge' | 'delete' | 'archive' | 'suppress'
   * @returns {Promise<Array<{ proposalId: string, status: string }>>}
   */
  async executeProposals(proposals, action) {
    const results = [];
    for (const proposal of proposals) {
      const effectiveAction = action || proposal.suggestedAction;
      try {
        const result = await this._executeProposal(proposal, effectiveAction);
        results.push({ proposalId: proposal.id, status: 'executed', ...result });
      } catch (err) {
        results.push({ proposalId: proposal.id, status: 'failed', error: err.message });
      }
    }
    return results;
  }

  // ── Detection methods ──────────────────────────────────────────────────────

  /**
   * Find near-duplicate memory clusters using Jaccard similarity.
   * Uses union-find to group transitively similar memories into clusters.
   */
  _findDuplicates(memories, tokenCache, threshold) {
    const proposals = [];
    // Track which memory IDs have already been assigned to a cluster
    const clustered = new Set();
    // Adjacency list for similarities above threshold
    const adjacent = new Map();

    for (let i = 0; i < memories.length; i++) {
      const tokensA = tokenCache.get(memories[i].id);
      if (!tokensA || tokensA.size === 0) continue;

      for (let j = i + 1; j < memories.length; j++) {
        const tokensB = tokenCache.get(memories[j].id);
        if (!tokensB || tokensB.size === 0) continue;

        const sim = jaccardSimilarity(tokensA, tokensB);
        if (sim >= threshold) {
          if (!adjacent.has(memories[i].id)) adjacent.set(memories[i].id, new Set());
          if (!adjacent.has(memories[j].id)) adjacent.set(memories[j].id, new Set());
          adjacent.get(memories[i].id).add(memories[j].id);
          adjacent.get(memories[j].id).add(memories[i].id);
        }
      }
    }

    // BFS to find connected components (clusters)
    const memById = new Map(memories.map(m => [m.id, m]));

    for (const startId of adjacent.keys()) {
      if (clustered.has(startId)) continue;

      const cluster = [];
      const queue = [startId];
      while (queue.length > 0) {
        const current = queue.pop();
        if (clustered.has(current)) continue;
        clustered.add(current);
        cluster.push(current);
        const neighbors = adjacent.get(current);
        if (neighbors) {
          for (const n of neighbors) {
            if (!clustered.has(n)) queue.push(n);
          }
        }
      }

      if (cluster.length < 2) continue;

      // Pick canonical: longest content, then highest importance
      const clusterMems = cluster.map(id => memById.get(id)).filter(Boolean);
      clusterMems.sort((a, b) => {
        const lenDiff = (b.content || '').length - (a.content || '').length;
        if (lenDiff !== 0) return lenDiff;
        return (b.importance_score || 0) - (a.importance_score || 0);
      });

      const canonicalId = clusterMems[0].id;
      const avgSimilarity = cluster.length > 1 ? threshold : threshold; // lower bound

      proposals.push({
        id: randomUUID(),
        category: 'duplicate',
        severity: cluster.length >= 4 ? 'high' : cluster.length >= 3 ? 'medium' : 'low',
        confidence: Math.min(0.95, avgSimilarity + 0.1),
        suggestedAction: 'merge',
        reason: `${cluster.length} memories contain nearly identical content` +
          (clusterMems[0].title ? ` about "${clusterMems[0].title}"` : ''),
        memories: clusterMems.map(m => ({
          id: m.id,
          title: m.title || null,
          content_preview: preview(m.content),
          created_at: m.created_at,
          importance_score: m.importance_score,
          is_canonical: m.id === canonicalId,
        })),
      });
    }

    return proposals;
  }

  /**
   * Find noise / spam memories.
   */
  _findNoise(memories, tokenCache) {
    const proposals = [];

    for (const mem of memories) {
      const content = mem.content || '';
      const reasons = [];

      // Check noise patterns (unsubscribe, noreply, etc.)
      for (const pattern of NOISE_PATTERNS) {
        if (pattern.test(content)) {
          reasons.push(`contains "${pattern.source.replace(/\\/g, '')}"`);
          break;
        }
      }

      // Very short content
      if (content.trim().length < 20 && content.trim().length > 0) {
        reasons.push(`very short content (${content.trim().length} chars)`);
      }

      // Pure whitespace / empty
      if (content.trim().length === 0) {
        reasons.push('empty content');
      }

      // Pure emoji / non-alphanumeric
      const alphanumeric = content.replace(/[^a-zA-Z0-9]/g, '');
      if (alphanumeric.length === 0 && content.trim().length > 0) {
        reasons.push('no alphanumeric content');
      }

      // Zero relationships + low importance (checked separately below as a weaker signal)
      if (reasons.length === 0) continue;

      proposals.push({
        id: randomUUID(),
        category: 'noise',
        severity: reasons.length >= 2 ? 'high' : 'medium',
        confidence: Math.min(0.95, 0.6 + reasons.length * 0.15),
        suggestedAction: 'delete',
        reason: reasons.join('; '),
        memories: [{
          id: mem.id,
          title: mem.title || null,
          content_preview: preview(content),
          created_at: mem.created_at,
          importance_score: mem.importance_score,
          is_canonical: false,
        }],
      });
    }

    return proposals;
  }

  /**
   * Find stale / outdated memories.
   */
  _findStale(memories) {
    const proposals = [];

    for (const mem of memories) {
      const reasons = [];
      const age = daysSince(mem.created_at);
      const importance = mem.importance_score ?? 0.5;
      const recallCount = mem.metadata?.recall_count || 0;

      // Superseded but still marked latest (data inconsistency)
      if (mem.is_latest === false) {
        reasons.push('marked as superseded (is_latest=false)');
      }

      // Old + low importance + never recalled
      if (age > 180 && importance < 0.3 && recallCount === 0) {
        reasons.push(`${Math.round(age)} days old, importance=${importance.toFixed(2)}, never recalled`);
      }

      if (reasons.length === 0) continue;

      proposals.push({
        id: randomUUID(),
        category: 'stale',
        severity: reasons.length >= 2 ? 'high' : age > 365 ? 'high' : 'medium',
        confidence: mem.is_latest === false ? 0.90 : 0.65,
        suggestedAction: 'archive',
        reason: reasons.join('; '),
        memories: [{
          id: mem.id,
          title: mem.title || null,
          content_preview: preview(mem.content),
          created_at: mem.created_at,
          importance_score: mem.importance_score,
          is_canonical: false,
        }],
      });
    }

    return proposals;
  }

  /**
   * Find orphan nodes with zero relationships.
   */
  _findOrphans(memories, relationships) {
    // Build set of all memory IDs that participate in any relationship
    const connected = new Set();
    for (const rel of relationships) {
      connected.add(rel.from_id);
      connected.add(rel.to_id);
    }

    const proposals = [];

    for (const mem of memories) {
      if (connected.has(mem.id)) continue;
      const age = daysSince(mem.created_at);
      if (age <= 7) continue; // Recently created, give them time

      const importance = mem.importance_score ?? 0.5;

      proposals.push({
        id: randomUUID(),
        category: 'orphan',
        severity: importance < 0.3 ? 'medium' : 'low',
        confidence: 0.50,
        suggestedAction: 'review',
        reason: `No relationships, ${Math.round(age)} days old` +
          (importance < 0.3 ? ', low importance' : ''),
        memories: [{
          id: mem.id,
          title: mem.title || null,
          content_preview: preview(mem.content),
          created_at: mem.created_at,
          importance_score: mem.importance_score,
          is_canonical: false,
        }],
      });
    }

    return proposals;
  }

  /**
   * Find TARA / session internal artifacts.
   */
  _findArtifacts(memories) {
    const proposals = [];

    for (const mem of memories) {
      const title = mem.title || '';
      const tags = mem.tags || [];
      let matched = false;

      for (const pattern of ARTIFACT_TITLE_PATTERNS) {
        if (pattern.test(title)) {
          matched = true;
          break;
        }
      }

      if (!matched) {
        for (const tag of tags) {
          if (ARTIFACT_TAGS.has(tag)) {
            matched = true;
            break;
          }
        }
      }

      if (!matched) continue;

      proposals.push({
        id: randomUUID(),
        category: 'artifact',
        severity: 'low',
        confidence: 0.85,
        suggestedAction: 'archive',
        reason: `Internal agent artifact: "${title || tags.join(', ')}"`,
        memories: [{
          id: mem.id,
          title: mem.title || null,
          content_preview: preview(mem.content),
          created_at: mem.created_at,
          importance_score: mem.importance_score,
          is_canonical: false,
        }],
      });
    }

    return proposals;
  }

  /**
   * Find contradiction clusters from existing Contradicts edges.
   */
  _findContradictions(memories, relationships) {
    const proposals = [];
    const contradictEdges = relationships.filter(r => r.type === 'Contradicts');

    if (contradictEdges.length === 0) return proposals;

    const memById = new Map(memories.map(m => [m.id, m]));

    // Group contradictions into clusters via connected components
    const adjacent = new Map();
    for (const edge of contradictEdges) {
      if (!adjacent.has(edge.from_id)) adjacent.set(edge.from_id, new Set());
      if (!adjacent.has(edge.to_id)) adjacent.set(edge.to_id, new Set());
      adjacent.get(edge.from_id).add(edge.to_id);
      adjacent.get(edge.to_id).add(edge.from_id);
    }

    const visited = new Set();

    for (const startId of adjacent.keys()) {
      if (visited.has(startId)) continue;

      const cluster = [];
      const queue = [startId];
      while (queue.length > 0) {
        const current = queue.pop();
        if (visited.has(current)) continue;
        visited.add(current);
        cluster.push(current);
        const neighbors = adjacent.get(current);
        if (neighbors) {
          for (const n of neighbors) {
            if (!visited.has(n)) queue.push(n);
          }
        }
      }

      if (cluster.length < 2) continue;

      const clusterMems = cluster.map(id => memById.get(id)).filter(Boolean);
      if (clusterMems.length < 2) continue;

      proposals.push({
        id: randomUUID(),
        category: 'contradiction',
        severity: 'high',
        confidence: 0.80,
        suggestedAction: 'resolve',
        reason: `${clusterMems.length} memories contain contradicting information` +
          (clusterMems[0].title ? ` about "${clusterMems[0].title}"` : ''),
        memories: clusterMems.map(m => ({
          id: m.id,
          title: m.title || null,
          content_preview: preview(m.content),
          created_at: m.created_at,
          importance_score: m.importance_score,
          is_canonical: false,
        })),
      });
    }

    return proposals;
  }

  // ── Execution ──────────────────────────────────────────────────────────────

  /**
   * Execute a single approved proposal.
   * @param {Proposal} proposal
   * @param {string} action - 'merge' | 'delete' | 'archive' | 'suppress' | 'resolve'
   */
  async _executeProposal(proposal, action) {
    switch (action) {
      case 'merge':
        return this._executeMerge(proposal);
      case 'delete':
        return this._executeDelete(proposal);
      case 'archive':
        return this._executeArchive(proposal);
      case 'suppress':
        return this._executeSuppress(proposal);
      case 'resolve':
        return this._executeResolve(proposal);
      default:
        throw new Error(`Unknown action: ${action}`);
    }
  }

  /**
   * Merge: keep canonical memory, mark others as not-latest, create Derives edges.
   */
  async _executeMerge(proposal) {
    const canonical = proposal.memories.find(m => m.is_canonical);
    if (!canonical) throw new Error('No canonical memory in proposal');

    const others = proposal.memories.filter(m => !m.is_canonical);
    let merged = 0;

    for (const dup of others) {
      // Create Derives edge: canonical derives from the duplicate
      await this.store.createRelationship({
        id: randomUUID(),
        from_id: canonical.id,
        to_id: dup.id,
        type: 'Derives',
        confidence: proposal.confidence,
        metadata: { source: 'hygiene-scanner', action: 'merge_duplicate' },
        created_by: 'hygiene-scanner',
      });

      // Mark duplicate as not-latest
      await this.store.updateMemory(dup.id, {
        isLatest: false,
        supersedesId: canonical.id,
      });

      merged++;
    }

    return { canonical: canonical.id, merged };
  }

  /**
   * Delete: hard-delete via store.deleteMemory (soft-delete with deletedAt).
   */
  async _executeDelete(proposal) {
    let deleted = 0;
    for (const mem of proposal.memories) {
      await this.store.deleteMemory(mem.id);
      deleted++;
    }
    return { deleted };
  }

  /**
   * Archive: set is_latest=false and drop importance to 0.05.
   */
  async _executeArchive(proposal) {
    let archived = 0;
    for (const mem of proposal.memories) {
      await this.store.updateMemory(mem.id, {
        isLatest: false,
        importanceScore: 0.05,
      });
      archived++;
    }
    return { archived };
  }

  /**
   * Suppress: keep memory searchable but drop importance to 0.05.
   */
  async _executeSuppress(proposal) {
    let suppressed = 0;
    for (const mem of proposal.memories) {
      await this.store.updateMemory(mem.id, {
        importanceScore: 0.05,
      });
      suppressed++;
    }
    return { suppressed };
  }

  /**
   * Resolve contradictions: mark the first memory as canonical (user should
   * have reordered if they prefer a different one), archive the rest.
   */
  async _executeResolve(proposal) {
    const [winner, ...losers] = proposal.memories;
    let resolved = 0;

    for (const loser of losers) {
      await this.store.updateMemory(loser.id, {
        isLatest: false,
        supersedesId: winner.id,
        importanceScore: 0.05,
      });
      resolved++;
    }

    return { winner: winner.id, resolved };
  }
}

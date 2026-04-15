/**
 * PageIndex Classifier — Embedding-based memory classification
 *
 * Classifies memories into PageIndex hierarchy nodes AUTOMATICALLY.
 * Runs during ingestion — uses embedding similarity to existing node contents.
 *
 * Flow:
 * 1. Get memory embedding (already computed during ingestion)
 * 2. Compare with existing PageIndex node memory embeddings
 * 3. Assign to best-matching node(s) based on similarity
 * 4. If no good match → create new topic node or assign to root
 */

import { PageIndexService } from './pageindex-service.js';

export class PageIndexClassifier {
  constructor({ prisma, logger = console }) {
    this.prisma = prisma;
    this.logger = logger;
    this.pageIndexService = new PageIndexService({ prisma, logger });
    // Pure keyword-based assignment (Postgres does not store embeddings in `memories`).
    this.KEYWORD_THRESHOLD = 0.35;
  }

  /**
   * Classify memory and assign to PageIndex node(s) automatically.
   * Called during ingestion pipeline.
   * @param {object} memory - { id, content, title, tags, userId, orgId, embedding }
   * @returns {Promise<{ assigned: boolean, nodeIds: string[], reason: string }>}
   */
  async classifyAndAssign(memory, options = {}) {
    try {
      // Check if PageIndex is available
      const available = await this.pageIndexService.isAvailable();
      if (!available) {
        return { assigned: false, nodeIds: [], reason: 'pageindex_unavailable' };
      }

      const userId = memory.userId || memory.user_id;
      const orgId = memory.orgId || memory.org_id || null;
      const project = memory.project || null;

      // Choose a project-scoped rootPath when possible.
      const projectRoot = project
        ? await this.pageIndexService.ensureProjectRootNode(userId, orgId, project)
        : null;
      const rootPath = options.rootPath || projectRoot?.path || this.pageIndexService.ROOT_PATH;
      const fallbackNodeId = options.fallbackNodeId || projectRoot?.id || null;

      // Get nodes under the scoped rootPath
      const nodes = await this.pageIndexService.getTree(userId, { rootPath });
      if (!nodes || nodes.length === 0) {
        // No nodes under scope — assign to project root if present, else global root.
        const globalRoot = await this.pageIndexService.ensureRootNode(userId, orgId);
        const targetId = fallbackNodeId || globalRoot?.id;
        if (targetId) {
          await this.pageIndexService.assignMemoryToNode(targetId, memory.id);
          return { assigned: true, nodeIds: [targetId], reason: 'no_nodes_in_scope_assigned_to_root' };
        }
        return { assigned: false, nodeIds: [], reason: 'root_creation_failed' };
      }

      // Find best matching node(s) using keyword matching
      const bestMatches = this._findBestMatchingNodesKeyword(memory, nodes);

      if (bestMatches.length === 0) {
        // No good match — assign to project root if available, else global root.
        const globalRoot = await this.pageIndexService.ensureRootNode(userId, orgId);
        const targetId = fallbackNodeId || globalRoot?.id;
        if (targetId) {
          await this.pageIndexService.assignMemoryToNode(targetId, memory.id);
          return { assigned: true, nodeIds: [targetId], reason: 'no_match_assigned_to_root' };
        }
        return { assigned: false, nodeIds: [], reason: 'root_creation_failed' };
      }

      // Assign to top matching nodes (max 3 for cross-referencing)
      const nodeIds = bestMatches.slice(0, 3).map(m => m.nodeId);

      for (const nodeId of nodeIds) {
        await this.pageIndexService.assignMemoryToNode(nodeId, memory.id);
      }

      this.logger.log(
        `[pageindex-classifier] Assigned ${memory.id.slice(0, 8)} to ${nodeIds.length} node(s): ${nodeIds.map(id => id.slice(0, 8)).join(', ')}`
      );

      return { assigned: true, nodeIds, reason: 'keyword_similarity' };
    } catch (err) {
      this.logger.warn('[pageindex-classifier] Classification failed:', err.message);
      return { assigned: false, nodeIds: [], reason: 'error', error: err.message };
    }
  }

  /**
   * Find best matching nodes using keyword similarity.
   * @private
   */
  _findBestMatchingNodesKeyword(memory, nodes) {
    // Flatten nodes to array with path info
    const nodePaths = this._flattenTree(nodes);

    if (nodePaths.length === 0) {
      return [];
    }

    // Score each node via keyword overlap between memory snippet/tags and node label/path.
    const scored = [];
    for (const node of nodePaths) {
      const keywordScore = this._keywordMatch(memory, node);
      if (keywordScore >= this.KEYWORD_THRESHOLD) {
        scored.push({ nodeId: node.id, path: node.path, score: keywordScore, method: 'keyword' });
      }
    }

    // Sort by score descending
    return scored.sort((a, b) => b.score - a.score);
  }

  /**
   * Keyword-based fallback matching.
   * @private
   */
  _keywordMatch(memory, node) {
    const memoryText = `${memory.title || ''} ${(memory.content || '').slice(0, 500)} ${(memory.tags || []).join(' ')}`.toLowerCase();
    const nodeLabel = node.label.toLowerCase();
    const nodePath = node.path.toLowerCase();

    // Extract tokens from memory
    const memoryTokens = memoryText
      .split(/\W+/)
      .filter(t => t.length > 2 && !this._isStopword(t));

    // Check overlap with node label/path
    const labelTokens = nodeLabel.split(/\W+/).filter(t => t.length > 2);
    const pathTokens = nodePath.split(/\W+/).filter(t => t.length > 2);
    const allNodeTokens = new Set([...labelTokens, ...pathTokens]);

    let overlap = 0;
    for (const token of memoryTokens) {
      if (allNodeTokens.has(token)) overlap++;
    }

    // Score based on overlap ratio
    const expectedOverlap = Math.min(memoryTokens.length, 10);
    return expectedOverlap > 0 ? Math.min(overlap / expectedOverlap, 1.0) : 0;
  }

  /**
   * Flatten tree to array of nodes.
   * @private
   */
  _flattenTree(nodes, results = []) {
    for (const node of nodes) {
      results.push({
        id: node.id,
        path: node.path,
        label: node.label,
        depth: node.depth,
        memoryIds: node.memoryIds || [],
      });
      if (node.children && node.children.length > 0) {
        this._flattenTree(node.children, results);
      }
    }
    return results;
  }

  /**
   * Check if word is a stopword.
   * @private
   */
  _isStopword(word) {
    const stopwords = new Set([
      'the', 'and', 'for', 'with', 'that', 'this', 'from', 'into', 'your', 'our',
      'are', 'was', 'were', 'can', 'could', 'would', 'should', 'will', 'just',
      'about', 'what', 'when', 'where', 'why', 'how', 'they', 'them', 'their',
    ]);
    return stopwords.has(word.toLowerCase());
  }
}

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
    this.SIMILARITY_THRESHOLD = 0.65; // Minimum cosine similarity to assign
  }

  /**
   * Classify memory and assign to PageIndex node(s) automatically.
   * Called during ingestion pipeline.
   * @param {object} memory - { id, content, title, tags, userId, orgId, embedding }
   * @returns {Promise<{ assigned: boolean, nodeIds: string[], reason: string }>}
   */
  async classifyAndAssign(memory) {
    try {
      // Check if PageIndex is available
      const available = await this.pageIndexService.isAvailable();
      if (!available) {
        return { assigned: false, nodeIds: [], reason: 'pageindex_unavailable' };
      }

      // Get or create root node for user
      const root = await this.pageIndexService.ensureRootNode(memory.userId, memory.orgId);
      if (!root) {
        return { assigned: false, nodeIds: [], reason: 'root_creation_failed' };
      }

      // Get all nodes for user
      const nodes = await this.pageIndexService.getTree(memory.userId);
      if (!nodes || nodes.length === 0) {
        // First memory for user — assign to root
        await this.pageIndexService.assignMemoryToNode(root.id, memory.id);
        return { assigned: true, nodeIds: [root.id], reason: 'first_memory_assigned_to_root' };
      }

      // Find best matching node(s) using embedding similarity
      const bestMatches = await this._findBestMatchingNodes(memory, nodes);

      if (bestMatches.length === 0) {
        // No good match — assign to root for now
        await this.pageIndexService.assignMemoryToNode(root.id, memory.id);
        return { assigned: true, nodeIds: [root.id], reason: 'no_match_found_assigned_to_root' };
      }

      // Assign to top matching nodes (max 3 for cross-referencing)
      const nodeIds = bestMatches.slice(0, 3).map(m => m.nodeId);

      for (const nodeId of nodeIds) {
        await this.pageIndexService.assignMemoryToNode(nodeId, memory.id);
      }

      this.logger.log(
        `[pageindex-classifier] Assigned ${memory.id.slice(0, 8)} to ${nodeIds.length} node(s): ${nodeIds.map(id => id.slice(0, 8)).join(', ')}`
      );

      return { assigned: true, nodeIds, reason: 'embedding_similarity' };
    } catch (err) {
      this.logger.warn('[pageindex-classifier] Classification failed:', err.message);
      return { assigned: false, nodeIds: [], reason: 'error', error: err.message };
    }
  }

  /**
   * Find best matching nodes using embedding similarity.
   * @private
   */
  async _findBestMatchingNodes(memory, nodes) {
    // Flatten nodes to array with path info
    const nodePaths = this._flattenTree(nodes);

    if (nodePaths.length === 0) {
      return [];
    }

    // For each node, compute similarity score based on:
    // 1. Memory embeddings already in that node
    // 2. Node label/topic keyword match

    const scored = [];

    for (const node of nodePaths) {
      if (!node.memoryIds || node.memoryIds.length === 0) {
        // Empty node — use keyword matching as fallback
        const keywordScore = this._keywordMatch(memory, node);
        if (keywordScore > 0.5) {
          scored.push({ nodeId: node.id, path: node.path, score: keywordScore, method: 'keyword' });
        }
        continue;
      }

      // Fetch embeddings of memories in this node (sample up to 10)
      const sampleMemoryIds = node.memoryIds.slice(0, 10);
      const memories = await this.prisma.memory.findMany({
        where: { id: { in: sampleMemoryIds }, deletedAt: null },
        select: { id: true, embedding: true, embeddingModel: true },
      });

      if (memories.length === 0 || !memories[0].embedding) {
        // No embeddings — fall back to keyword
        const keywordScore = this._keywordMatch(memory, node);
        if (keywordScore > 0.5) {
          scored.push({ nodeId: node.id, path: node.path, score: keywordScore, method: 'keyword' });
        }
        continue;
      }

      // Compute average similarity to memories in this node
      const similarities = memories.map(m => {
        if (!memory.embedding || !m.embedding) return 0;
        return this._cosineSimilarity(memory.embedding, m.embedding);
      });

      const avgSimilarity = similarities.reduce((a, b) => a + b, 0) / similarities.length;
      const maxSimilarity = Math.max(...similarities);

      // Use max similarity (best match in node) weighted with avg
      const combinedScore = (maxSimilarity * 0.7) + (avgSimilarity * 0.3);

      if (combinedScore >= this.SIMILARITY_THRESHOLD) {
        scored.push({
          nodeId: node.id,
          path: node.path,
          score: combinedScore,
          method: 'embedding',
          avgSimilarity,
          maxSimilarity,
        });
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
   * Compute cosine similarity between two embeddings.
   * @private
   */
  _cosineSimilarity(a, b) {
    if (!a || !b || a.length !== b.length) return 0;

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    if (normA === 0 || normB === 0) return 0;

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
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

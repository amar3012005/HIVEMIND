/**
 * PageIndex Evolution Agent — Auto-evolves hierarchy structure
 *
 * Periodically audits PageIndex nodes and recommends:
 * - Pruning sparse nodes (<5 memories after 30 days)
 * - Splitting large nodes (>100 memories)
 * - Merging similar sibling nodes
 * - Creating new branches from emerging patterns
 *
 * Runs as a background job (every 6 hours via cron).
 */

import { PageIndexService } from '../services/pageindex-service.js';

const PRUNE_THRESHOLD = 5; // memories
const PRUNE_AFTER_DAYS = 30;
const SPLIT_THRESHOLD = 100; // memories
const MERGE_SIMILARITY_THRESHOLD = 0.7; // Jaccard overlap

export class PageIndexEvolutionAgent {
  constructor({ prisma, logger = console }) {
    this.prisma = prisma;
    this.logger = logger;
    this.pageIndexService = new PageIndexService({ prisma, logger });
  }

  /**
   * Run full evolution audit for all users.
   * Called by cron job every 6 hours.
   */
  async runEvolutionCycle(options = {}) {
    const { userId = null, orgId = null } = options;

    this.logger.log('[pageindex-evolution] Starting evolution cycle...');

    // Get all users with PageIndex nodes
    const users = await this._getUsersWithPageIndex();
    this.logger.log(`[pageindex-evolution] Found ${users.length} users with PageIndex`);

    const results = {
      pruned: 0,
      split: 0,
      merged: 0,
      created: 0,
      errors: 0,
    };

    for (const user of users) {
      if (userId && user.id !== userId) continue; // Filter by user if specified

      try {
        const userResults = await this._evolveUserHierarchy(user.id, orgId);
        results.pruned += userResults.pruned;
        results.split += userResults.split;
        results.merged += userResults.merged;
        results.created += userResults.created;
      } catch (err) {
        this.logger.error(`[pageindex-evolution] Failed for user ${user.id}:`, err.message);
        results.errors++;
      }
    }

    this.logger.log(
      `[pageindex-evolution] Cycle complete: ` +
      `${results.pruned} pruned, ${results.split} split, ` +
      `${results.merged} merged, ${results.created} created, ${results.errors} errors`
    );

    return results;
  }

  /**
   * Evolve hierarchy for a single user.
   * @private
   */
  async _evolveUserHierarchy(userId, orgId) {
    const results = { pruned: 0, split: 0, merged: 0, created: 0 };

    // 1. Prune sparse nodes
    const pruned = await this.pageIndexService.pruneSparseNodes(userId, {
      minMemories: PRUNE_THRESHOLD,
      daysOld: PRUNE_AFTER_DAYS,
    });
    results.pruned += pruned;

    // 2. Split large nodes
    const split = await this._splitLargeNodes(userId);
    results.split += split;

    // 3. Merge similar siblings
    const merged = await this._mergeSimilarSiblings(userId);
    results.merged += merged;

    // 4. Create new branches from emerging patterns
    const created = await this._createEmergentBranches(userId, orgId);
    results.created += created;

    return results;
  }

  /**
   * Split nodes with >100 memories into subtopics.
   * @private
   */
  async _splitLargeNodes(userId) {
    const tree = await this.pageIndexService.getTree(userId);
    if (!tree) return 0;

    const flatNodes = this._flattenTree(tree);
    let splitCount = 0;

    for (const node of flatNodes) {
      if (node.memoryCount > SPLIT_THRESHOLD && node.depth < 4) {
        try {
          await this._splitNode(node);
          splitCount++;
        } catch (err) {
          this.logger.warn(`[pageindex-evolution] Failed to split node ${node.id}:`, err.message);
        }
      }
    }

    return splitCount;
  }

  /**
   * Split a node into subtopics using LLM clustering.
   * @private
   */
  async _splitNode(node) {
    this.logger.log(`[pageindex-evolution] Splitting large node: ${node.path} (${node.memoryCount} memories)`);

    // Fetch memories in this node
    const memories = await this.prisma.memory.findMany({
      where: { id: { in: node.memoryIds } },
      select: { id: true, content: true, title: true, tags: true },
      take: 50, // Sample for clustering
    });

    // Use LLM to detect subtopics
    const subtopics = await this._detectSubtopics(memories);

    if (subtopics.length < 2) {
      this.logger.log(`[pageindex-evolution] No clear subtopics for ${node.path}`);
      return;
    }

    // Create child nodes for each subtopic
    for (const subtopic of subtopics) {
      const childNode = await this.pageIndexService.createNode({
        userId: node.userId,
        orgId: node.orgId,
        parentId: node.id,
        label: subtopic.label,
        nodeType: 'subtopic',
      });

      if (childNode) {
        // Assign relevant memories to child
        const relevantMemoryIds = subtopic.memoryIds || [];
        for (const memoryId of relevantMemoryIds) {
          await this.pageIndexService.assignMemoryToNode(childNode.id, memoryId);
        }
      }
    }

    this.logger.log(`[pageindex-evolution] Created ${subtopics.length} subtopics under ${node.path}`);
  }

  /**
   * Detect subtopics using LLM clustering.
   * @private
   */
  async _detectSubtopics(memories) {
    const groqApiKey = process.env.GROQ_API_KEY;
    if (!groqApiKey) {
      // Fallback: simple keyword-based clustering
      return this._keywordCluster(memories);
    }

    const contentSamples = memories.slice(0, 20).map(m => ({
      title: m.title || 'Untitled',
      tags: (m.tags || []).join(', '),
      preview: (m.content || '').slice(0, 300),
    }));

    try {
      const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${groqApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            {
              role: 'system',
              content: `You are a topic clustering expert. Given a set of memories, identify 2-5 coherent subtopics.

Return ONLY valid JSON:
{
  "subtopics": [
    { "label": "Short name (2-4 words)", "memory_ids": ["id1", "id2"], "description": "What this subtopic covers" }
  ]
}

Rules:
- Each subtopic should have 5+ memories
- Labels should be specific and descriptive
- Memories can only belong to ONE subtopic`,
            },
            {
              role: 'user',
              content: `Cluster these memories into subtopics:

${JSON.stringify(contentSamples, null, 2)}`,
            },
          ],
          max_tokens: 1000,
          temperature: 0.1,
          response_format: { type: 'json_object' },
        }),
      });

      if (!resp.ok) throw new Error(`Groq ${resp.status}`);

      const data = await resp.json();
      const parsed = JSON.parse(data.choices[0]?.message?.content || '{}');

      return (parsed.subtopics || []).map(s => ({
        label: s.label,
        memoryIds: s.memory_ids || [],
        description: s.description,
      }));
    } catch (err) {
      this.logger.warn('[pageindex-evolution] LLM clustering failed, using keywords:', err.message);
      return this._keywordCluster(memories);
    }
  }

  /**
   * Fallback keyword-based clustering.
   * @private
   */
  _keywordCluster(memories) {
    // Simple approach: group by most common tag
    const tagCounts = new Map();
    for (const memory of memories) {
      for (const tag of (memory.tags || [])) {
        tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1);
      }
    }

    const topTags = [...tagCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([tag]) => tag);

    if (topTags.length === 0) return [];

    return topTags.map(tag => ({
      label: tag,
      memoryIds: memories
        .filter(m => (m.tags || []).includes(tag))
        .map(m => m.id),
    }));
  }

  /**
   * Merge sibling nodes with high keyword overlap.
   * @private
   */
  async _mergeSimilarSiblings(userId) {
    const tree = await this.pageIndexService.getTree(userId);
    if (!tree) return 0;

    const flatNodes = this._flattenTree(tree);
    let mergeCount = 0;

    // Group by parent
    const siblingsByParent = new Map();
    for (const node of flatNodes) {
      if (node.parentId) {
        if (!siblingsByParent.has(node.parentId)) {
          siblingsByParent.set(node.parentId, []);
        }
        siblingsByParent.get(node.parentId).push(node);
      }
    }

    // Check each sibling group for similar pairs
    for (const [parentId, siblings] of siblingsByParent.entries()) {
      if (siblings.length < 2) continue;

      for (let i = 0; i < siblings.length; i++) {
        for (let j = i + 1; j < siblings.length; j++) {
          const similarity = this._computeNodeSimilarity(siblings[i], siblings[j]);
          if (similarity >= MERGE_SIMILARITY_THRESHOLD) {
            await this._mergeNodes(siblings[i].id, siblings[j].id);
            mergeCount++;
          }
        }
      }
    }

    return mergeCount;
  }

  /**
   * Compute similarity between two nodes (Jaccard overlap of keywords).
   * @private
   */
  _computeNodeSimilarity(nodeA, nodeB) {
    const tokensA = new Set(
      nodeA.label.toLowerCase().split(/\W+/).filter(t => t.length > 2)
    );
    const tokensB = new Set(
      nodeB.label.toLowerCase().split(/\W+/).filter(t => t.length > 2)
    );

    const intersection = [...tokensA].filter(t => tokensB.has(t)).length;
    const union = new Set([...tokensA, ...tokensB]).size;

    return union === 0 ? 0 : intersection / union;
  }

  /**
   * Merge node B into node A.
   * @private
   */
  async _mergeNodes(nodeAId, nodeBId) {
    const nodeA = await this.prisma.pageIndexNode.findUnique({
      where: { id: nodeAId },
      select: { memoryIds: true },
    });

    const nodeB = await this.prisma.pageIndexNode.findUnique({
      where: { id: nodeBId },
      select: { memoryIds: true },
    });

    if (!nodeA || !nodeB) return;

    // Merge memory IDs
    const allMemoryIds = [...new Set([...nodeA.memoryIds, ...nodeB.memoryIds])];

    // Update node A
    await this.prisma.pageIndexNode.update({
      where: { id: nodeAId },
      data: {
        memoryIds: allMemoryIds,
        memoryCount: allMemoryIds.length,
      },
    });

    // Delete node B (memories already in A)
    await this.pageIndexService.deleteNode(nodeBId, { reassignMemories: false });

    this.logger.log(`[pageindex-evolution] Merged ${nodeBId} into ${nodeAId}`);
  }

  /**
   * Create new branches from emerging memory patterns.
   * @private
   */
  async _createEmergentBranches(userId, orgId) {
    // Find memories not yet in any PageIndex node
    const allMemories = await this.prisma.memory.findMany({
      where: { userId, deletedAt: null },
      select: { id: true, tags: true },
    });

    const tree = await this.pageIndexService.getTree(userId);
    const flatNodes = this._flattenTree(tree);
    const indexedMemoryIds = new Set(flatNodes.flatMap(n => n.memoryIds || []));

    const unindexedMemories = allMemories.filter(m => !indexedMemoryIds.has(m.id));

    if (unindexedMemories.length < 10) return 0; // Not enough to create branches

    // Cluster unindexed memories by tags
    const tagClusters = this._groupByCommonTags(unindexedMemories);

    let createdCount = 0;
    for (const [tag, memories] of Object.entries(tagClusters)) {
      if (memories.length >= 5) {
        // Create new node for this emerging topic
        const newNode = await this.pageIndexService.createNode({
          userId,
          orgId,
          parentId: null, // Top-level for now
          label: tag.charAt(0).toUpperCase() + tag.slice(1),
          nodeType: 'topic',
        });

        if (newNode) {
          for (const memory of memories.slice(0, 50)) {
            await this.pageIndexService.assignMemoryToNode(newNode.id, memory.id);
          }
          createdCount++;
        }
      }
    }

    return createdCount;
  }

  /**
   * Group memories by common tags.
   * @private
   */
  _groupByCommonTags(memories) {
    const groups = {};
    for (const memory of memories) {
      for (const tag of (memory.tags || [])) {
        if (!groups[tag]) groups[tag] = [];
        groups[tag].push(memory);
      }
    }
    return groups;
  }

  /**
   * Flatten tree to array.
   * @private
   */
  _flattenTree(nodes, results = []) {
    for (const node of nodes) {
      results.push({
        ...node,
        children: undefined, // Exclude children for flat array
      });
      if (node.children && node.children.length > 0) {
        this._flattenTree(node.children, results);
      }
    }
    return results;
  }

  /**
   * Get users with PageIndex nodes.
   * @private
   */
  async _getUsersWithPageIndex() {
    try {
      const tableExists = await this.pageIndexService.isAvailable();
      if (!tableExists) return [];

      const result = await this.prisma.pageIndexNode.groupBy({
        by: ['userId'],
        _count: true,
      });

      return result.map(r => ({ id: r.userId }));
    } catch (err) {
      return [];
    }
  }
}

/**
 * PageIndex Integration — Hooks into ingestion pipeline
 *
 * Async, non-blocking classification and node assignment.
 * Uses embedding similarity to assign memories to existing nodes.
 * Never fails ingestion — silently degrades if PageIndex unavailable.
 *
 * Usage:
 *   const pageindexHook = new PageIndexIntegration({ prisma });
 *   await pageindexHook.onMemoryIngested({ id, userId, orgId, content, title, tags, embedding });
 */

import { PageIndexService } from '../services/pageindex-service.js';
import { PageIndexClassifier } from '../services/pageindex-classifier.js';

export class PageIndexIntegration {
  constructor({ prisma, logger = console }) {
    this.prisma = prisma;
    this.logger = logger;
    this.pageIndexService = new PageIndexService({ prisma, logger });
    this.classifier = new PageIndexClassifier({ prisma, logger });
  }

  /**
   * Called after memory is persisted to PostgreSQL with embedding.
   * Fire-and-forget — doesn't block ingestion.
   *
   * @param {object} memory - { id, userId, orgId, content, title, tags, embedding }
   * @returns {Promise<void>} (never throws)
   */
  async onMemoryIngested(memory) {
    try {
      // Check if PageIndex is available
      const available = await this.pageIndexService.isAvailable();
      if (!available) {
        this.logger.log('[pageindex-hook] PageIndex not available, skipping classification');
        return;
      }

      // Classify and assign to nodes (uses embedding similarity)
      const result = await this.classifier.classifyAndAssign(memory);

      if (result.assigned) {
        this.logger.log(
          `[pageindex-hook] Memory ${memory.id.slice(0, 8)} assigned to ${result.nodeIds.length} node(s): ${result.reason}`
        );

        // Trigger summary generation for nodes that need it
        for (const nodeId of result.nodeIds) {
          this._maybeGenerateSummary(nodeId).catch(err => {
            this.logger.warn('[pageindex-hook] Summary generation failed:', err.message);
          });
        }
      } else {
        this.logger.log(`[pageindex-hook] Memory ${memory.id.slice(0, 8)} not assigned: ${result.reason}`);
      }

    } catch (err) {
      this.logger.warn('[pageindex-hook] Classification failed:', err.message);
      // Never throw — ingestion continues regardless
    }
  }

  /**
   * Generate summary for node if it has enough memories.
   * @private
   */
  async _maybeGenerateSummary(nodeId) {
    const node = await this.prisma.pageIndexNode.findUnique({
      where: { id: nodeId },
      select: {
        id: true,
        memoryCount: true,
        summary: true,
        summaryUpdatedAt: true,
      },
    });

    if (!node) return;

    // Generate summary if: >= 5 memories AND (no summary OR summary > 24h old)
    const shouldGenerate =
      node.memoryCount >= 5 &&
      (!node.summary ||
        (node.summaryUpdatedAt &&
          Date.now() - node.summaryUpdatedAt.getTime() > 24 * 60 * 60 * 1000));

    if (shouldGenerate) {
      await this.pageIndexService.generateNodeSummary(nodeId);
    }
  }

  /**
   * Batch classification for backfill.
   * @param {array} memories - Array of memory objects with embeddings
   * @returns {Promise<{ assigned: number, total: number }>}
   */
  async classifyBatch(memories) {
    let assigned = 0;

    for (const memory of memories) {
      try {
        const result = await this.classifier.classifyAndAssign(memory);
        if (result.assigned) assigned++;
      } catch (err) {
        this.logger.warn(`[pageindex-hook] Failed to classify ${memory.id}:`, err.message);
      }
    }

    return { assigned, total: memories.length };
  }
}

// Event emitter integration (optional)
export function setupIngestionEventListener(eventBus, pageindexHook) {
  eventBus.on('memory.ingested', async (event) => {
    if (!event.memory_ids || event.memory_ids.length === 0) return;

    // Fetch memory with embeddings
    const prisma = pageindexHook.prisma;
    const memories = await prisma.memory.findMany({
      where: { id: { in: event.memory_ids } },
      select: {
        id: true, userId: true, orgId: true,
        content: true, title: true, tags: true,
        embedding: true, embeddingModel: true,
      },
    });

    // Classify each memory
    for (const memory of memories) {
      await pageindexHook.onMemoryIngested(memory);
    }
  });
}

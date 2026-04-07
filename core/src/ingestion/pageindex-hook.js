/**
 * PageIndex Integration — Hooks into ingestion pipeline
 *
 * Async, non-blocking classification and node assignment.
 * Never fails ingestion — silently degrades if PageIndex unavailable.
 *
 * Usage:
 *   const pageindexHook = new PageIndexIntegration({ prisma });
 *   await pageindexHook.onMemoryIngested({ memoryId, userId, orgId, content, ... });
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
   * Called after memory is persisted to PostgreSQL.
   * Fire-and-forget — doesn't block ingestion.
   *
   * @param {object} memory - { id, userId, orgId, content, title, tags }
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

      // Ensure root node exists
      await this.pageIndexService.ensureRootNode(memory.userId, memory.orgId);

      // Classify and assign (async, non-blocking)
      await this.classifier.classifyAsync(memory);

    } catch (err) {
      this.logger.warn('[pageindex-hook] Classification failed:', err.message);
      // Never throw — ingestion continues regardless
    }
  }

  /**
   * Batch classification for backfill.
   * @param {array} memories - Array of memory objects
   * @returns {Promise<{ classified: number, total: number }>}
   */
  async classifyBatch(memories) {
    let classified = 0;

    for (const memory of memories) {
      try {
        const result = await this.classifier.classify(memory);
        if (result.paths && result.paths.length > 0) {
          classified++;
        }
      } catch (err) {
        this.logger.warn(`[pageindex-hook] Failed to classify ${memory.id}:`, err.message);
      }
    }

    return { classified, total: memories.length };
  }
}

// Event emitter integration (optional)
export function setupIngestionEventListener(eventBus, pageindexHook) {
  eventBus.on('memory.ingested', async (event) => {
    if (!event.memory_ids || event.memory_ids.length === 0) return;

    // Fetch memory details
    const prisma = pageindexHook.prisma;
    const memories = await prisma.memory.findMany({
      where: { id: { in: event.memory_ids } },
      select: { id: true, userId: true, orgId: true, content: true, title: true, tags: true },
    });

    // Classify each memory
    for (const memory of memories) {
      await pageindexHook.onMemoryIngested(memory);
    }
  });
}

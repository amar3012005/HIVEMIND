/**
 * PageIndex Integration — Hooks into ingestion pipeline
 *
 * NOTE: `core/src/ingestion/` is CommonJS (see core/src/ingestion/package.json),
 * so this module must remain CommonJS. It lazily imports ESM PageIndex
 * dependencies from `core/src/services/`.
 *
 * Behavior:
 * - Non-blocking, best-effort PageIndex assignment after a memory is persisted.
 * - Deterministic taxonomy first (project root + halls + tags), then keyword
 *   similarity classification within the project subtree.
 * - If a memory updates prior IDs, migrate membership (remove deprecated IDs,
 *   add new ID) to keep PageIndex primarily "latest".
 */

class PageIndexIntegration {
  constructor({ prisma, logger = console }) {
    this.prisma = prisma;
    this.logger = logger;

    this.pageIndexService = null;
    this.classifier = null;
    this._depsPromise = null;
  }

  async _deps() {
    if (!this._depsPromise) {
      this._depsPromise = (async () => {
        const { PageIndexService } = await import('../services/pageindex-service.js');
        const { PageIndexClassifier } = await import('../services/pageindex-classifier.js');
        return { PageIndexService, PageIndexClassifier };
      })();
    }
    return this._depsPromise;
  }

  async _init() {
    if (this.pageIndexService && this.classifier) return;
    const { PageIndexService, PageIndexClassifier } = await this._deps();
    this.pageIndexService = new PageIndexService({ prisma: this.prisma, logger: this.logger });
    this.classifier = new PageIndexClassifier({ prisma: this.prisma, logger: this.logger });
  }

  /**
   * Called after memory is persisted to PostgreSQL.
   * Fire-and-forget — doesn't block ingestion.
   *
   * @param {object} memory - { id, userId/user_id, orgId/org_id, project, content, title, tags, memoryType/memory_type }
   * @param {object} [options]
   * @param {object} [options.mutation] - { operation, deprecatedIds }
   * @returns {Promise<void>} (never throws)
   */
  async onMemoryIngested(memory, options = {}) {
    try {
      await this._init();

      const available = await this.pageIndexService.isAvailable();
      if (!available) {
        this.logger.log('[pageindex-hook] PageIndex not available, skipping classification');
        return;
      }

      const userId = memory.userId || memory.user_id;
      const orgId = memory.orgId || memory.org_id || null;
      const project = memory.project || null;

      // Ensure project subtree exists and always assign the memory to the project root.
      const projectRoot = project
        ? await this.pageIndexService.ensureProjectRootNode(userId, orgId, project)
        : null;
      if (projectRoot) {
        await this.pageIndexService.assignMemoryToNode(projectRoot.id, memory.id);

        // Lightweight "hall" nodes under the project (depth 4). Mimics MemPalace halls.
        const hallLabel = this._hallLabelForMemory(memory);
        if (hallLabel) {
          const hallNode = await this.pageIndexService.createNode({
            userId,
            orgId,
            parentId: projectRoot.id,
            label: hallLabel,
            nodeType: 'category',
          });
          if (hallNode) {
            await this.pageIndexService.assignMemoryToNode(hallNode.id, memory.id);
          }
        }

        // Tag nodes under the project (depth 4). Assign to top N tags only.
        const tags = Array.isArray(memory.tags) ? memory.tags : [];
        for (const tag of tags.slice(0, 3)) {
          const tagNode = await this.pageIndexService.createNode({
            userId,
            orgId,
            parentId: projectRoot.id,
            label: `tag:${tag}`,
            nodeType: 'topic',
          });
          if (tagNode) {
            await this.pageIndexService.assignMemoryToNode(tagNode.id, memory.id);
          }
        }
      }

      // If this memory supersedes prior IDs, migrate PageIndex membership.
      const mutation = options.mutation || null;
      const deprecatedIds = Array.isArray(mutation?.deprecatedIds) ? mutation.deprecatedIds : [];
      if (deprecatedIds.length > 0) {
        for (const deprecatedId of deprecatedIds) {
          const nodes = await this.pageIndexService.findNodesForMemory(deprecatedId);
          if (!nodes?.length) continue;
          for (const node of nodes) {
            await this.pageIndexService.removeMemoryFromNode(node.id, deprecatedId);
            await this.pageIndexService.assignMemoryToNode(node.id, memory.id);
          }
        }
      }

      // Keyword classification within project scope (best-effort, non-blocking).
      const result = await this.classifier.classifyAndAssign(memory, {
        rootPath: projectRoot?.path || null,
        fallbackNodeId: projectRoot?.id || null,
      });

      if (result?.assigned) {
        this.logger.log(
          `[pageindex-hook] Memory ${String(memory.id).slice(0, 8)} assigned to ${result.nodeIds.length} node(s): ${result.reason}`
        );
      }
    } catch (err) {
      this.logger.warn('[pageindex-hook] Classification failed:', err.message);
    }
  }

  _hallLabelForMemory(memory) {
    const type = String(memory.memoryType || memory.memory_type || '').toLowerCase();
    if (!type) return 'notes';
    if (type === 'fact') return 'facts';
    if (type === 'decision') return 'decisions';
    if (type === 'preference') return 'preferences';
    if (type === 'observation') return 'observations';
    if (type === 'code') return 'code';
    if (type === 'email') return 'emails';
    if (type === 'task') return 'tasks';
    return 'notes';
  }

  async classifyBatch(memories) {
    await this._init();
    let assigned = 0;

    for (const memory of memories) {
      try {
        const result = await this.classifier.classifyAndAssign(memory, {
          rootPath: memory.project ? `${this.pageIndexService.PROJECTS_PATH}/${this.pageIndexService._slugify(memory.project)}` : null,
        });
        if (result?.assigned) assigned++;
      } catch (err) {
        this.logger.warn(`[pageindex-hook] Failed to classify ${memory.id}:`, err.message);
      }
    }

    return { assigned, total: memories.length };
  }
}

function setupIngestionEventListener(eventBus, pageindexHook) {
  eventBus.on('memory.ingested', async (event) => {
    if (!event.memory_ids || event.memory_ids.length === 0) return;

    // Fetch memory payload (Postgres does not store embeddings in `memories`)
    const prisma = pageindexHook.prisma;
    const memories = await prisma.memory.findMany({
      where: { id: { in: event.memory_ids } },
      select: {
        id: true,
        userId: true,
        orgId: true,
        project: true,
        content: true,
        title: true,
        tags: true,
        memoryType: true,
      },
    });

    for (const memory of memories) {
      await pageindexHook.onMemoryIngested(memory);
    }
  });
}

module.exports = {
  PageIndexIntegration,
  setupIngestionEventListener,
};


/**
 * Bi-Temporal Knowledge Graph
 *
 * Independently tracks WHEN an event happened (valid_time) vs WHEN the system
 * learned it (transaction_time). Enables "time-travel" queries.
 *
 * Architecture (per NotebookLM research):
 *   - Transaction Time: MemoryVersion.createdAt (append-only ledger)
 *   - Valid Time Start: Memory.documentDate
 *   - Valid Time End: Memory.metadata.valid_to (null = currently valid)
 *   - No schema changes — uses existing fields + metadata JSON
 *   - MemoryVersion acts as immutable event source
 *
 * @module memory/bi-temporal
 */

/**
 * BiTemporalEngine — time-travel queries and temporal reasoning.
 */
export class BiTemporalEngine {
  /**
   * @param {object} opts
   * @param {object} opts.store — PrismaGraphStore or InMemoryGraphStore
   * @param {object} [opts.prisma] — Raw Prisma client for advanced queries
   */
  constructor({ store, prisma } = {}) {
    if (!store) throw new Error('BiTemporalEngine requires a store');
    this.store = store;
    this.prisma = prisma || store.client;
  }

  /**
   * AS-OF-TRANSACTION: What did the system know at a given transaction time?
   *
   * @param {string} userId
   * @param {string} orgId
   * @param {Date|string} transactionTime
   * @returns {Promise<Array>}
   */
  async asOfTransaction(userId, orgId, transactionTime) {
    const txTime = new Date(transactionTime);

    if (!this.prisma) {
      // Use all memories (not just isLatest) to include superseded historical records.
      const allMemories = this.store.memories
        ? Array.from(this.store.memories.values()).filter(
            m => m.user_id === userId && m.org_id === orgId && !m.deleted_at
          )
        : await this.store.listLatestMemories({ user_id: userId, org_id: orgId });
      return allMemories
        .filter(m => new Date(m.created_at) <= txTime)
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(m => ({
          memoryId: m.id, content: m.content, version: m.version || 1,
          memory_type: m.memory_type, createdAt: m.created_at,
          documentDate: m.document_date, metadata: m.metadata || {}, tags: m.tags || []
        }));
    }

    // Query memories directly: all that existed at txTime (not filtered by isLatest —
    // historical snapshots must include memories that were later superseded).
    const memories = await this.prisma.memory.findMany({
      where: {
        userId,
        orgId,
        createdAt: { lte: new Date(txTime) },
        deletedAt: null
      },
      orderBy: { createdAt: 'desc' }
    });

    return memories.map(mem => ({
      memoryId: mem.id, content: mem.content || '', version: mem.version || 1,
      memory_type: mem.memoryType || 'fact',
      createdAt: mem.createdAt instanceof Date ? mem.createdAt.toISOString() : mem.createdAt,
      documentDate: mem.documentDate instanceof Date ? mem.documentDate.toISOString() : (mem.documentDate || null),
      metadata: mem.metadata || {}, tags: mem.tags || [], isLatest: mem.isLatest
    }));
  }

  /**
   * AS-OF-VALID: What was true in the real world at a given valid time?
   *
   * @param {string} userId
   * @param {string} orgId
   * @param {Date|string} validTime
   * @returns {Promise<Array>}
   */
  async asOfValid(userId, orgId, validTime) {
    const vTime = new Date(validTime);

    if (!this.prisma) {
      // Use all memories (not just isLatest) to include superseded historical records.
      const allMemories = this.store.memories
        ? Array.from(this.store.memories.values()).filter(
            m => m.user_id === userId && m.org_id === orgId && !m.deleted_at
          )
        : await this.store.listLatestMemories({ user_id: userId, org_id: orgId });
      return allMemories.filter(m => {
        const docDate = m.document_date ? new Date(m.document_date) : new Date(m.created_at);
        const validTo = m.metadata?.valid_to ? new Date(m.metadata.valid_to) : null;
        return docDate <= vTime && (!validTo || validTo >= vTime);
      }).map(m => ({
        memoryId: m.id, content: m.content, memory_type: m.memory_type,
        documentDate: m.document_date, validTo: m.metadata?.valid_to || null, tags: m.tags || []
      }));
    }

    const memories = await this.prisma.memory.findMany({
      where: { userId, orgId, deletedAt: null, documentDate: { lte: vTime } }
    });

    return memories
      .filter(m => {
        const validTo = (m.metadata || {}).valid_to;
        return !validTo || new Date(validTo) >= vTime;
      })
      .map(m => ({
        memoryId: m.id, content: m.content, memory_type: m.memoryType,
        documentDate: m.documentDate instanceof Date ? m.documentDate.toISOString() : m.documentDate,
        validTo: (m.metadata || {}).valid_to || null, isLatest: m.isLatest, tags: m.tags || []
      }));
  }

  /**
   * BI-TEMPORAL SNAPSHOT: Combined query.
   * "What did the system know at transaction_time about the world at valid_time?"
   *
   * @param {string} userId
   * @param {string} orgId
   * @param {Date|string} transactionTime
   * @param {Date|string} validTime
   * @returns {Promise<Array>}
   */
  async biTemporalSnapshot(userId, orgId, transactionTime, validTime) {
    const vTime = new Date(validTime);
    const txState = await this.asOfTransaction(userId, orgId, transactionTime);

    return txState.filter(m => {
      const docDate = m.documentDate ? new Date(m.documentDate) : new Date(m.createdAt);
      const validTo = m.metadata?.valid_to ? new Date(m.metadata.valid_to) : null;
      return docDate <= vTime && (!validTo || validTo >= vTime);
    });
  }

  /**
   * TEMPORAL DIFF: What changed between two points in time?
   *
   * @param {string} userId
   * @param {string} orgId
   * @param {Date|string} timeA — earlier time
   * @param {Date|string} timeB — later time
   * @returns {Promise<{ added: Array, removed: Array, modified: Array, summary: string }>}
   */
  async temporalDiff(userId, orgId, timeA, timeB) {
    const [snapshotA, snapshotB] = await Promise.all([
      this.asOfTransaction(userId, orgId, timeA),
      this.asOfTransaction(userId, orgId, timeB)
    ]);

    const mapA = new Map(snapshotA.map(m => [m.memoryId, m]));
    const mapB = new Map(snapshotB.map(m => [m.memoryId, m]));
    const diff = { added: [], removed: [], modified: [] };

    for (const [id, memB] of mapB.entries()) {
      if (!mapA.has(id)) {
        diff.added.push({ memoryId: id, content: (memB.content || '').slice(0, 200), memory_type: memB.memory_type });
      } else {
        const memA = mapA.get(id);
        if (memA.version !== memB.version) {
          diff.modified.push({
            memoryId: id,
            before: { content: (memA.content || '').slice(0, 200), version: memA.version },
            after: { content: (memB.content || '').slice(0, 200), version: memB.version }
          });
        }
      }
    }

    for (const [id, memA] of mapA.entries()) {
      if (!mapB.has(id)) {
        diff.removed.push({ memoryId: id, content: (memA.content || '').slice(0, 200), memory_type: memA.memory_type });
      }
    }

    diff.summary = `${diff.added.length} added, ${diff.removed.length} removed, ${diff.modified.length} modified`;
    return diff;
  }

  /**
   * TEMPORAL TIMELINE: Full version history of a specific memory.
   *
   * @param {string} memoryId
   * @returns {Promise<Array>}
   */
  async getTemporalTimeline(memoryId) {
    if (!this.prisma) return [];

    const versions = await this.prisma.memoryVersion.findMany({
      where: { memoryId },
      orderBy: { createdAt: 'asc' }
    });

    return versions.map(v => ({
      version: v.version, isLatest: v.isLatest, reason: v.reason,
      relatedMemoryId: v.relatedMemoryId, contentHash: v.contentHash,
      createdAt: v.createdAt instanceof Date ? v.createdAt.toISOString() : v.createdAt,
      metadata: v.metadata || {}
    }));
  }

  /**
   * Close the valid_to window on a memory (mark it as no longer true).
   *
   * @param {string} memoryId
   * @param {Date|string} validTo
   * @returns {Promise<{ success: boolean }>}
   */
  async closeValidWindow(memoryId, validTo) {
    if (!this.prisma) return { success: false, reason: 'No Prisma client' };

    const memory = await this.prisma.memory.findUnique({ where: { id: memoryId }, select: { metadata: true } });
    if (!memory) return { success: false, reason: 'Memory not found' };

    await this.prisma.memory.update({
      where: { id: memoryId },
      data: { metadata: { ...(memory.metadata || {}), valid_to: new Date(validTo).toISOString() } }
    });

    return { success: true, memoryId, validTo: new Date(validTo).toISOString() };
  }
}

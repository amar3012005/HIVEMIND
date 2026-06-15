/**
 * ClusterIndex — durable cluster-state table interface.
 *
 * Powers dirty-cluster scheduling in cognition-loop without requiring a
 * full table-scan of raw memories every tick. One row per
 * (organization_id, user_id, cluster_hash).
 *
 * Design decisions:
 *   - dirty_count tracks how many NEW source memories have arrived since the
 *     last tick processed this cluster. Incremented from within cognition-loop
 *     (Option A: ingest-time wiring deferred to a later phase).
 *   - Upsert on (org, user, hash) — fully idempotent, safe to call repeatedly.
 *   - recordRecall runs in setImmediate so it never blocks a recall response.
 *   - All writes that touch dirty_count are atomic via raw SQL
 *     (UPDATE ... SET dirty_count = dirty_count + N) to avoid lost-update race.
 */

export class ClusterIndex {
  /**
   * @param {{ prisma: import('@prisma/client').PrismaClient }} opts
   */
  constructor({ prisma }) {
    this.prisma = prisma;
  }

  // ─── Upsert after synthesis write ──────────────────────────────────────────
  /**
   * Called from cognition-loop after every successful synthesis write
   * (CREATE / REAFFIRM / EXTEND / CONTRADICT). IRRELEVANT decisions are no-ops
   * and should NOT call this.
   *
   * Resets dirty_count to 0 — the tick just consumed all known dirty evidence.
   */
  async upsertOnSynthesis({
    organizationId,
    userId,
    clusterHash,
    clusterType,
    entityKeys = [],
    topTags = [],
    latestSynthesisId,
    latestRevision,
    latestConfidence,
    evidenceCountTotal = 0,
  }) {
    try {
      await this.prisma.clusterIndex.upsert({
        where: {
          organizationId_userId_clusterHash: { organizationId, userId, clusterHash },
        },
        create: {
          organizationId,
          userId,
          clusterHash,
          clusterType,
          entityKeys,
          topTags,
          evidenceCount:    evidenceCountTotal,
          dirtyCount:       0,
          latestSynthesisId: latestSynthesisId || null,
          latestRevision:    latestRevision || 1,
          latestConfidence:  latestConfidence != null ? latestConfidence : null,
          lastTickAt:        new Date(),
        },
        update: {
          clusterType,
          entityKeys,
          topTags,
          evidenceCount:    evidenceCountTotal,
          dirtyCount:       0,               // reset — tick consumed dirty evidence
          latestSynthesisId: latestSynthesisId || undefined,
          latestRevision:    latestRevision || 1,
          latestConfidence:  latestConfidence != null ? latestConfidence : undefined,
          lastTickAt:        new Date(),
          updatedAt:         new Date(),
        },
      });
    } catch (err) {
      // H14: log clearly and rethrow so callers can retry/warn rather than silently orphaning the synthesis.
      console.error(`[cluster-index] upsertOnSynthesis FAILED hash=${clusterHash} latestSynthesisId=${latestSynthesisId}: ${err.message}`);
      throw err;
    }
  }

  // ─── Read hot (dirty) clusters ─────────────────────────────────────────────
  /**
   * Return clusters whose dirty_count has reached the threshold — i.e. enough
   * new source memories piled up since the last synthesis to warrant an early
   * dream. Drives WS1 event-driven scheduling (scheduler._maybeEarlyDream).
   *
   * @param {{ organizationId: string, minDirty?: number, limit?: number }} opts
   * @returns {Promise<Array<{ clusterHash: string, dirtyCount: number, clusterType: string }>>}
   */
  async getDirtyClusters({ organizationId, minDirty = 5, limit = 50 }) {
    if (!organizationId || organizationId === 'undefined') return [];
    try {
      const rows = await this.prisma.clusterIndex.findMany({
        where: { organizationId, dirtyCount: { gte: minDirty } },
        orderBy: { dirtyCount: 'desc' },
        take: limit,
        select: { clusterHash: true, dirtyCount: true, clusterType: true },
      });
      return rows.map((r) => ({
        clusterHash: r.clusterHash,
        dirtyCount: r.dirtyCount,
        clusterType: r.clusterType,
      }));
    } catch (err) {
      console.warn(`[cluster-index] getDirtyClusters failed org=${organizationId}: ${err.message}`);
      return [];
    }
  }

  // ─── Bump dirty count (atomic) ─────────────────────────────────────────────
  // Wired at ingest time from graph-engine._bumpClusterDirty (fire-and-forget)
  // and read by getDirtyClusters for event-driven early dreams. upsertOnSynthesis
  // resets dirty_count to 0 when a tick consumes the cluster.
  /**
   * Increment dirty_count for a cluster. Called when a new source memory arrives
   * for this cluster hash (ingest) or when cognition-loop discovers new members.
   * Creates a stub row if none exists yet.
   *
   * Uses raw SQL UPDATE for atomicity — Prisma's updateMany cannot do
   * `SET dirty_count = dirty_count + N` without a race.
   *
   * @param {{ organizationId: string, userId: string, clusterHash: string, clusterType?: string, by?: number }} opts
   */
  async bumpDirty({ organizationId, userId, clusterHash, clusterType = 'unknown', by = 1 }) {
    // Guard against undefined/null UUIDs — caller occasionally passes
    // members[0].userId when a connector-sourced memory has no user (org
    // scope) or no org (personal scope). Both columns are NOT NULL uuid so
    // a missing value triggers Postgres 22P02 (invalid input syntax).
    if (!organizationId || !userId || !clusterHash
        || organizationId === 'undefined' || userId === 'undefined') {
      return;
    }
    try {
      // Atomic upsert: create stub row OR add to dirty_count.
      // Cast UUID params to ::uuid explicitly — Prisma $executeRawUnsafe binds
      // all JS strings as 'text' but the column type is uuid, causing PG error 42804.
      await this.prisma.$executeRawUnsafe(
        `INSERT INTO hivemind.cluster_index
           (id, organization_id, user_id, cluster_hash, cluster_type,
            dirty_count, latest_revision, created_at, updated_at)
         VALUES
           (gen_random_uuid(), $1::uuid, $2::uuid, $3, $4, $5, 0, now(), now())
         ON CONFLICT (organization_id, user_id, cluster_hash)
         DO UPDATE SET
           dirty_count = hivemind.cluster_index.dirty_count + $5,
           updated_at  = now()`,
        organizationId,
        userId,
        clusterHash,
        clusterType,
        by,
      );
    } catch (err) {
      console.warn(`[cluster-index] bumpDirty failed hash=${clusterHash}: ${err.message}`);
    }
  }

  // ─── Record recall hit (async fire-and-forget) ─────────────────────────────
  /**
   * Bump recall_count_30d + last_recall_at for all cluster hashes returned
   * in a recall result set. Called via setImmediate so it never blocks recall.
   *
   * @param {{ clusterHashes: string[] }} opts
   */
  async recordRecall({ clusterHashes = [] }) {
    if (!clusterHashes.length) return;
    try {
      await this.prisma.$executeRawUnsafe(
        `UPDATE hivemind.cluster_index
         SET last_recall_at   = NOW(),
             recall_count_30d = recall_count_30d + 1
         WHERE cluster_hash = ANY($1::text[])`,
        clusterHashes,
      );
    } catch (err) {
      // Non-fatal metric write — warn only
      console.warn(`[cluster-index] recordRecall failed: ${err.message}`);
    }
  }
}

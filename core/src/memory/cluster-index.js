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
      // Non-fatal: cluster_index is a performance optimisation, not a gate
      console.warn(`[cluster-index] upsertOnSynthesis failed hash=${clusterHash}: ${err.message}`);
    }
  }

  // ─── Bump dirty count (atomic) ─────────────────────────────────────────────
  /**
   * Increment dirty_count for a cluster. Called when cognition-loop discovers
   * new source memories that have arrived since the last synthesis for this
   * cluster hash. Creates a stub row if none exists yet.
   *
   * Uses raw SQL UPDATE for atomicity — Prisma's updateMany cannot do
   * `SET dirty_count = dirty_count + N` without a race.
   *
   * @param {{ organizationId: string, userId: string, clusterHash: string, clusterType?: string, by?: number }} opts
   */
  async bumpDirty({ organizationId, userId, clusterHash, clusterType = 'unknown', by = 1 }) {
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

  // ─── Reset dirty count after tick ─────────────────────────────────────────
  async resetDirty({ id }) {
    try {
      await this.prisma.clusterIndex.update({
        where:  { id },
        data:   { dirtyCount: 0, lastTickAt: new Date() },
      });
    } catch (err) {
      console.warn(`[cluster-index] resetDirty id=${id} failed: ${err.message}`);
    }
  }

  // ─── Get dirty clusters (scheduler) ────────────────────────────────────────
  /**
   * Returns clusters ordered by dirty_count desc. cognition-loop uses this
   * to prioritise which clusters to synthesise next.
   *
   * @param {{ organizationId: string, minDirty?: number, limit?: number }} opts
   */
  async getDirtyClusters({ organizationId, minDirty = 3, limit = 50 }) {
    try {
      return await this.prisma.clusterIndex.findMany({
        where: {
          organizationId,
          dirtyCount: { gte: minDirty },
        },
        orderBy: { dirtyCount: 'desc' },
        take:    limit,
      });
    } catch (err) {
      console.warn(`[cluster-index] getDirtyClusters failed: ${err.message}`);
      return [];
    }
  }

  // ─── Cross-cluster entity overlap lookup ────────────────────────────────────
  /**
   * Returns clusters sharing at least one entity with the given set.
   * Used by crossClusterEntityBoost in persisted-retrieval.js.
   *
   * @param {{ organizationId: string, entityKeys: string[], excludeHashes?: string[], limit?: number }} opts
   */
  async getClustersByEntityOverlap({ organizationId, entityKeys, excludeHashes = [], limit = 50 }) {
    if (!entityKeys || !entityKeys.length) return [];
    try {
      return await this.prisma.clusterIndex.findMany({
        where: {
          organizationId,
          ...(excludeHashes.length > 0
            ? { clusterHash: { notIn: excludeHashes } }
            : {}),
          entityKeys: { hasSome: entityKeys },
        },
        select: {
          clusterHash:       true,
          entityKeys:        true,
          latestConfidence:  true,
          latestSynthesisId: true,
          latestRevision:    true,
        },
        take: limit,
      });
    } catch (err) {
      console.warn(`[cluster-index] getClustersByEntityOverlap failed: ${err.message}`);
      return [];
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

  // ─── 30-day recall decay (nightly job, stub) ────────────────────────────────
  /**
   * Decay recall_count_30d by removing counts older than 30 days.
   * TODO: wire as a nightly cron (Day 3).
   */
  async decayRecallCounts() {
    /* TODO Day 3 — implement rolling 30-day decay with a separate
       recall_events table or a periodic reset approach */
  }
}

/**
 * Orphaned-cognition pruner.
 *
 * Cognition-loop outputs (canonical/bridge/principle syntheses + distilled-from-kb
 * facts) are DERIVED memories: they summarize upstream source memories / KB docs.
 * When every one of a derived memory's upstream sources is deleted, the derived
 * memory is an orphan — it asserts facts whose evidence no longer exists. The KB
 * delete cascade (purgeMemories / purgeKnowledgeDocs) removed the sources + their
 * Derives edges + evidence links, but left the derived syntheses behind (the bug
 * the user hit: "I deleted the Solvis memories but the summaries are still there").
 *
 * This module finds derived memories that became orphaned by a delete and hard-
 * purges them too — recursively, since deleting a canonical can orphan a bridge
 * or principle built on top of it.
 *
 * A memory is pruned ONLY when:
 *   - it is a cognition output (memory_type='synthesis' OR a cognition-loop /
 *     distilled-from-kb tag), AND
 *   - it HAD at least one upstream reference (Derives edge, synthesisEvidenceIds,
 *     or a memory_evidence_links row), AND
 *   - NONE of those upstreams resolve to a live row anymore.
 * Source/raw memories and unparented manual syntheses are never touched.
 */

import { orgIsRemote } from '../vector/mneme/driver.js';
import { currentOrg } from '../db/prisma.js';

const COGNITION_TAGS = ['cognition-loop', 'distilled-from-kb'];

function isCognitionOutput(m) {
  if (!m) return false;
  if (m.memoryType === 'synthesis') return true;
  const tags = m.tags || [];
  return COGNITION_TAGS.some((t) => tags.includes(t));
}

/**
 * Collect the derived cognition outputs that reference any of `rootIds`.
 * MUST be called BEFORE the roots' relationships are deleted (the Derives edges
 * source→derived are how we find the parents; purgeMemories deletes them).
 * @returns {Promise<string[]>} candidate derived-memory ids
 */
export async function collectDerivedCandidates(prisma, rootIds) {
  const ids = Array.from(new Set((rootIds || []).filter(Boolean)));
  if (!ids.length) return [];
  // Remote (self-host): edges/evidence live on the agent — agent-side orphan pruning not yet implemented.
  const _collectOrg = currentOrg();
  if (_collectOrg && orgIsRemote(_collectOrg)) {
    console.log(`[orphan-pruner] skip remote org=${String(_collectOrg).slice(0, 8)} — agent-side orphan pruning not yet implemented`);
    return [];
  }
  const candidates = new Set();
  // Derives edges point FROM the synthesis TO its source — so a source in `ids`
  // is the `toId`; the derived memory is the `fromId`.
  try {
    const edges = await prisma.relationship.findMany({
      where: { toId: { in: ids }, type: 'Derives' },
      select: { fromId: true },
    });
    for (const e of edges) if (e.fromId) candidates.add(e.fromId);
  } catch { /* best-effort */ }
  // Syntheses that list a deleted id in their evidence array.
  try {
    const byEvidence = await prisma.memory.findMany({
      where: { synthesisEvidenceIds: { hasSome: ids }, deletedAt: null },
      select: { id: true },
    });
    for (const m of byEvidence) candidates.add(m.id);
  } catch { /* best-effort */ }
  // Subtract the roots themselves (a root could also be a synthesis).
  for (const id of ids) candidates.delete(id);
  return Array.from(candidates);
}

/**
 * Periodic safety sweep: scan an org's cognition outputs and prune any that are
 * orphaned (no live upstream). Catches orphans from delete paths that don't call
 * the event-driven prune (direct DB deletes, unwired endpoints). Bounded by
 * `limit` cognition rows scanned per call.
 * @returns {Promise<{ scanned: number, prunedIds: string[] }>}
 */
export async function sweepOrphanedCognition({ prisma, orgId, limit = 2000, logger = console, qdrantUrl, qdrantKey }) {
  if (!prisma || !orgId) return { scanned: 0, prunedIds: [] };
  // Remote (self-host): cognition rows live on the agent — agent-side orphan pruning not yet implemented.
  if (orgIsRemote(orgId)) {
    logger?.log?.(`[orphan-pruner] skip remote org=${String(orgId).slice(0, 8)} — agent-side orphan pruning not yet implemented`);
    return { scanned: 0, prunedIds: [] };
  }
  let cog = [];
  try {
    cog = await prisma.memory.findMany({
      where: {
        orgId, deletedAt: null,
        OR: [{ memoryType: 'synthesis' }, { tags: { has: 'cognition-loop' } }, { tags: { has: 'distilled-from-kb' } }],
      },
      select: { id: true },
      take: limit,
    });
  } catch (e) { logger?.warn?.(`[orphan-pruner] sweep scan failed org=${String(orgId).slice(0, 8)}: ${e.message}`); return { scanned: 0, prunedIds: [] }; }
  // Reuse the same orphan test + recursion via pruneOrphanedCognition; every
  // cognition row is a candidate.
  const { prunedIds } = await pruneOrphanedCognition({
    prisma, orgId, candidateIds: cog.map((m) => m.id), logger, qdrantUrl, qdrantKey,
  });
  if (prunedIds.length) logger?.log?.(`[orphan-pruner] sweep org=${String(orgId).slice(0, 8)} scanned=${cog.length} pruned=${prunedIds.length}`);
  return { scanned: cog.length, prunedIds };
}

/** True when `id` is a cognition output whose every upstream is now dead. */
async function isOrphanedDerived(prisma, id) {
  const m = await prisma.memory.findUnique({
    where: { id },
    select: { id: true, memoryType: true, tags: true, synthesisEvidenceIds: true },
  }).catch(() => null);
  if (!m || !isCognitionOutput(m)) return false;

  // A source counts as "still there" if its ROW EXISTS — even soft-deleted
  // (deletedAt set). Soft delete is reversible, so a synthesis whose sources are
  // merely soft-deleted must NOT be pruned (only HARD-deleted, row-gone sources
  // orphan it). This is what keeps the scheduled sweep from nuking syntheses for
  // recoverable sources, and is why soft delete intentionally does not cascade.
  const ev = m.synthesisEvidenceIds || [];
  const liveEv = ev.length
    ? await prisma.memory.count({ where: { id: { in: ev } } })
    : 0;

  const der = await prisma.relationship.findMany({
    where: { fromId: id, type: 'Derives' }, select: { toId: true },
  }).catch(() => []);
  const liveSrc = der.length
    ? await prisma.memory.count({ where: { id: { in: der.map((d) => d.toId) } } })
    : 0;

  let links = [];
  try {
    links = await prisma.memoryEvidenceLink.findMany({ where: { memoryId: id }, select: { documentId: true } });
  } catch { links = []; }
  const docIds = links.map((l) => l.documentId).filter(Boolean);
  const liveDocs = docIds.length
    ? await prisma.knowledgeDocument.count({ where: { id: { in: docIds } } })
    : 0;

  const hadUpstream = ev.length > 0 || der.length > 0 || links.length > 0;
  return hadUpstream && liveEv === 0 && liveSrc === 0 && liveDocs === 0;
}

/** Hard-purge a set of derived memories + their FK refs + vectors. */
async function purgeDerived(prisma, ids, { orgId, qdrantUrl, qdrantKey, logger }) {
  if (!ids.length) return;
  await prisma.memoryVersion.updateMany({ where: { relatedMemoryId: { in: ids } }, data: { relatedMemoryId: null } }).catch(() => {});
  await prisma.memoryVersion.deleteMany({ where: { memoryId: { in: ids } } }).catch(() => {});
  await prisma.relationship.deleteMany({ where: { OR: [{ fromId: { in: ids } }, { toId: { in: ids } }] } }).catch(() => {});
  await prisma.memoryEvidenceLink.deleteMany({ where: { memoryId: { in: ids } } }).catch(() => {});
  await prisma.memoryProject.deleteMany({ where: { memoryId: { in: ids } } }).catch(() => {});
  await prisma.sourceMetadata.deleteMany({ where: { memoryId: { in: ids } } }).catch(() => {});
  await prisma.memory.deleteMany({ where: { id: { in: ids } } }).catch((e) => logger?.warn?.(`[orphan-pruner] memory delete failed: ${e.message}`));
  if (qdrantUrl && orgId) {
    for (const coll of [`org_${orgId}`, 'HIVEMIND_PERSONAL']) {
      await fetch(`${qdrantUrl}/collections/${encodeURIComponent(coll)}/points/delete?wait=true`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(qdrantKey ? { 'api-key': qdrantKey } : {}) },
        body: JSON.stringify({ points: ids }),
      }).catch(() => {});
    }
  }
}

/**
 * Prune cognition outputs orphaned by a just-completed delete.
 * @param {object} args
 * @param {import('@prisma/client').PrismaClient} args.prisma
 * @param {string} args.orgId
 * @param {string[]} args.candidateIds  derived memories that referenced the deleted roots
 *                                       (from collectDerivedCandidates, captured pre-purge)
 * @param {number} [args.maxDepth=5]    recursion bound (canonical→bridge→principle chains)
 * @returns {Promise<{ prunedIds: string[] }>}
 */
export async function pruneOrphanedCognition({ prisma, orgId, candidateIds = [], maxDepth = 5, logger = console, qdrantUrl, qdrantKey }) {
  // Remote (self-host): cognition rows/edges live on the agent — agent-side orphan pruning not yet implemented.
  if (orgId && orgIsRemote(orgId)) {
    logger?.log?.(`[orphan-pruner] skip remote org=${String(orgId).slice(0, 8)} — agent-side orphan pruning not yet implemented`);
    return { prunedIds: [] };
  }
  const prunedIds = [];
  const seen = new Set();
  let frontier = Array.from(new Set((candidateIds || []).filter(Boolean)));
  let depth = 0;
  const qUrl = qdrantUrl || process.env.QDRANT_URL || process.env.QDRANT_CLOUD_URL;
  const qKey = qdrantKey || process.env.QDRANT_API_KEY || '';

  while (frontier.length && depth < maxDepth) {
    const orphans = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      if (await isOrphanedDerived(prisma, id)) orphans.push(id);
    }
    if (!orphans.length) break;
    // Capture the next layer (parents that derive from these orphans) BEFORE purge
    // deletes their edges.
    const next = await collectDerivedCandidates(prisma, orphans);
    await purgeDerived(prisma, orphans, { orgId, qdrantUrl: qUrl, qdrantKey: qKey, logger });
    prunedIds.push(...orphans);
    logger?.log?.(`[orphan-pruner] depth=${depth} pruned ${orphans.length} orphaned cognition output(s)`);
    frontier = next.filter((id) => !seen.has(id));
    depth += 1;
  }
  return { prunedIds };
}

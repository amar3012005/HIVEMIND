/**
 * cluster-index-backfill.mjs
 *
 * Reads all isLatest=true synthesis memories (canonical-fact + synthesis-bridge),
 * groups by clusterHash, and upserts cluster_index rows.
 *
 * Dry-run by default. Pass --commit to write.
 *
 * Usage:
 *   node /app/scripts/cluster-index-backfill.mjs [--commit]
 */
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const dryRun = !process.argv.includes('--commit');

console.log(`[backfill] cluster-index backfill — dry_run=${dryRun}`);

async function main() {
  // Fetch all isLatest synthesis memories
  const synths = await prisma.memory.findMany({
    where: {
      isLatest:   true,
      deletedAt:  null,
      memoryType: 'synthesis',
      synthesisClusterHash: { not: null },
    },
    select: {
      id: true,
      orgId: true,
      userId: true,
      synthesisClusterHash: true,
      synthesisRevision: true,
      synthesisConfidence: true,
      synthesisEvidenceIds: true,
      tags: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  console.log(`[backfill] found ${synths.length} synthesis memories to index`);

  // Group by clusterHash — keep highest revision per hash
  const byHash = new Map();
  for (const m of synths) {
    const hash = m.synthesisClusterHash;
    if (!hash) continue;
    const existing = byHash.get(hash);
    if (!existing || (m.synthesisRevision || 1) >= (existing.synthesisRevision || 1)) {
      byHash.set(hash, m);
    }
  }

  console.log(`[backfill] unique cluster hashes: ${byHash.size}`);

  let upserted = 0;
  let errors = 0;

  for (const [hash, m] of byHash.entries()) {
    if (!m.orgId || !m.userId) {
      console.warn(`[backfill] skip hash=${hash} missing orgId/userId`);
      continue;
    }

    // Determine cluster type from tags
    const tags = m.tags || [];
    const clusterType = tags.includes('synthesis:canonical') ? 'canonical-fact'
                      : tags.includes('synthesis:bridge')   ? 'synthesis-bridge'
                      : 'unknown';

    // Extract entity keys from tags (entity:* tags)
    const entityKeys = tags.filter(t => t.startsWith('entity:')).map(t => t.slice(7));

    // Top topic tags
    const SYS_TAG_RE = /^(file:|fn:|page:|heading:|upload:|doc-hash:|promoted-from|synthesized|topic:|cognition-loop|synthesis:|knowledge-base$|document$|document-summary$|entity:|time:|ts:|section:|chat$|talk-to-hive$)/i;
    const topTags = tags.filter(t => !SYS_TAG_RE.test(t)).slice(0, 10);

    const evidenceCount = (m.synthesisEvidenceIds || []).length;

    if (dryRun) {
      console.log(`[backfill][dry] would upsert hash=${hash.slice(0,12)} type=${clusterType} rev=${m.synthesisRevision} conf=${m.synthesisConfidence} org=${m.orgId.slice(0,8)}`);
      upserted++;
      continue;
    }

    try {
      await prisma.clusterIndex.upsert({
        where: {
          organizationId_userId_clusterHash: {
            organizationId: m.orgId,
            userId: m.userId,
            clusterHash: hash,
          },
        },
        create: {
          organizationId:    m.orgId,
          userId:            m.userId,
          clusterHash:       hash,
          clusterType,
          entityKeys,
          topTags,
          evidenceCount,
          dirtyCount:        0,
          latestSynthesisId: m.id,
          latestRevision:    m.synthesisRevision || 1,
          latestConfidence:  m.synthesisConfidence || null,
          lastTickAt:        m.updatedAt || m.createdAt || new Date(),
        },
        update: {
          clusterType,
          entityKeys,
          topTags,
          evidenceCount,
          latestSynthesisId: m.id,
          latestRevision:    m.synthesisRevision || 1,
          latestConfidence:  m.synthesisConfidence || null,
          lastTickAt:        m.updatedAt || m.createdAt || new Date(),
          updatedAt:         new Date(),
        },
      });
      upserted++;
      if (upserted % 50 === 0) {
        console.log(`[backfill] progress: ${upserted}/${byHash.size}`);
      }
    } catch (err) {
      console.warn(`[backfill] upsert failed hash=${hash}: ${err.message}`);
      errors++;
    }
  }

  console.log(`[backfill] done — upserted=${upserted} errors=${errors} dry_run=${dryRun}`);
}

main()
  .catch(err => { console.error('[backfill] fatal:', err); process.exit(1); })
  .finally(() => prisma.$disconnect());

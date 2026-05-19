#!/usr/bin/env node
/**
 * One-shot script: remove legacy chunk-as-memory points from BUNDB AGENT
 * Qdrant collection where the same memory now has memory_evidence_links
 * (i.e. Phase 1 has superseded the chunk).
 *
 * Usage:
 *   node scripts/cleanup-legacy-bundb-chunks.js --dry-run
 *   node scripts/cleanup-legacy-bundb-chunks.js --execute
 */

import { PrismaClient } from '@prisma/client';

const QDRANT_URL = process.env.QDRANT_URL || 'http://localhost:6333';
const API_KEY = process.env.QDRANT_API_KEY || '';
const COLLECTION = process.env.MEMORY_QDRANT_COLLECTION || 'BUNDB AGENT';

const headers = { 'Content-Type': 'application/json', ...(API_KEY && { 'api-key': API_KEY }) };
const dry = !process.argv.includes('--execute');

async function main() {
  const prisma = new PrismaClient();
  await prisma.$connect();

  // Memories that have evidence_links (i.e. Phase 1 backed)
  const phase1Memories = await prisma.memoryEvidenceLink.findMany({
    select: { memoryId: true },
    distinct: ['memoryId'],
  });
  const phase1Ids = new Set(phase1Memories.map(r => r.memoryId));
  console.log(`Phase 1 backed memories: ${phase1Ids.size}`);

  // Memories tagged source_type=knowledge_segment in legacy table (the
  // chunks-as-memory we want to retire). Heuristic: tags array contains
  // 'promoted-from-segment' AND has evidence_link.
  const candidates = await prisma.memory.findMany({
    where: {
      id: { in: Array.from(phase1Ids) },
      tags: { hasSome: ['promoted-from-segment'] },
      deletedAt: null,
    },
    select: { id: true, tags: true },
    take: 5000,
  });
  console.log(`Candidates for legacy chunk cleanup: ${candidates.length}`);

  if (dry) {
    console.log('DRY RUN — no changes. Re-run with --execute to actually remove.');
    for (const c of candidates.slice(0, 10)) console.log(' would remove:', c.id);
    await prisma.$disconnect();
    return;
  }

  // Remove Qdrant points; keep Memory row (still useful for graph/text recall)
  let removed = 0;
  for (const c of candidates) {
    try {
      const res = await fetch(`${QDRANT_URL}/collections/${COLLECTION}/points/delete?wait=true`, {
        method: 'POST', headers,
        body: JSON.stringify({ points: [c.id] }),
      });
      if (res.ok) removed++;
    } catch (err) {
      console.warn(`Failed to remove point ${c.id}: ${err.message}`);
    }
  }
  console.log(`Removed ${removed}/${candidates.length} Qdrant points`);
  await prisma.$disconnect();
}

main().catch(err => { console.error(err); process.exit(1); });

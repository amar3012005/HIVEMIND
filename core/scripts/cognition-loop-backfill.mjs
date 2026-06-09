#!/usr/bin/env node
/**
 * cognition-loop-backfill.mjs — Phase 2 Cognition Loop backfill
 *
 * Iterates over ALL users with ≥20 memories and runs the full synthesis pass
 * (Phase 1 fresh-synthesis + Phase 2 delta-update) against their entire
 * history (365d lookback override).
 *
 * Usage:
 *   node /app/scripts/cognition-loop-backfill.mjs                  # dry-run (default)
 *   node /app/scripts/cognition-loop-backfill.mjs --commit          # real writes
 *   node /app/scripts/cognition-loop-backfill.mjs --commit --user_id=<uuid>
 *
 * Safe to re-run: 6h cooldown per cluster_hash prevents duplicate synthesis.
 * Phase 2 delta-update only fires when new evidence exists after last synthesis.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

const args  = process.argv.slice(2);
const COMMIT  = args.includes('--commit');
const USER_ARG = args.find(a => a.startsWith('--user_id='))?.split('=')[1] || null;
const DRY_RUN = !COMMIT;

if (DRY_RUN) {
  console.log('[backfill] DRY-RUN mode — pass --commit for actual writes');
}

async function main() {
  // Dynamic imports so this works at /app/ inside the container
  const { CognitionLoop } = await import('../src/memory/cognition-loop.js');
  const { PrismaGraphStore } = await import('../src/memory/prisma-graph-store.js');

  // Stub engine: dry-run logs instead of writing
  let engine;
  if (DRY_RUN) {
    engine = {
      ingestMemory: async (payload) => {
        console.log(`  [DRY_RUN] would ingest: ${payload.title}`);
        return null;
      },
    };
  } else {
    // Wire the real engine — import graph-engine and give it prisma + store
    try {
      const { MemoryGraphEngine } = await import('../src/memory/graph-engine.js');
      // PrismaGraphStore's constructor is POSITIONAL: constructor(client). Passing
      // { prisma } sets this.client = { prisma } → this.client.$transaction is
      // undefined → ingestMemory throws and silently falls back to direct insert
      // (no embedding, no role). Match server.js: new PrismaGraphStore(prisma).
      const store = new PrismaGraphStore(prisma);
      engine = new MemoryGraphEngine({ store });
    } catch (err) {
      console.warn(`[backfill] could not load MemoryGraphEngine (${err.message}), falling back to direct insert`);
      engine = null; // CognitionLoop falls back to direct Prisma insert
    }
  }

  const store = new PrismaGraphStore(prisma);
  const loop = new CognitionLoop({
    prisma,
    memoryGraphEngine: engine,
    persistentMemoryStore: store,
    logger: console,
  });

  // Override lookback to cover full history
  process.env.SYNTHESIS_LOOKBACK_HOURS = String(365 * 24);

  // Determine which users to run
  let users;
  if (USER_ARG) {
    users = [{ userId: USER_ARG }];
    console.log(`[backfill] targeting single user ${USER_ARG}`);
  } else {
    // Find all users with ≥20 non-deleted memories
    const grouped = await prisma.memory.groupBy({
      by: ['userId'],
      where: { deletedAt: null },
      _count: { id: true },
      having: { id: { _count: { gte: 20 } } },
    });
    users = grouped.map(g => ({ userId: g.userId }));
    console.log(`[backfill] found ${users.length} users with ≥20 memories`);
  }

  // Per-user, look up their orgId
  const results = [];
  for (const { userId } of users) {
    const membership = await prisma.userOrganization.findFirst({
      where: { userId },
      select: { orgId: true },
    });
    if (!membership) {
      console.warn(`[backfill] user ${userId} has no org — skipping`);
      continue;
    }
    const orgId = membership.orgId;

    // Count synthesis memories before run
    const beforeCount = await prisma.memory.count({
      where: {
        userId, orgId, isLatest: true, deletedAt: null,
        synthesisClusterHash: { not: null },
      },
    });

    console.log(`\n[backfill] user=${userId} org=${orgId} synthesis_before=${beforeCount}`);

    let canonical_facts_created = 0;
    let bridges_created = 0;
    let revisions_bumped = 0;

    if (DRY_RUN) {
      // Just report clusters
      const synth = await loop.synthesizeForOrg(orgId);
      console.log(`  [DRY_RUN] would touch ~${synth} clusters`);
      results.push({ user_id: userId, dry_run: true, clusters_touched: synth });
      continue;
    }

    // Real run — synthesize and count what changed
    const synthBefore = await prisma.memory.count({
      where: { userId, orgId, deletedAt: null, tags: { hasSome: ['synthesis:canonical'] } },
    });
    const bridgeBefore = await prisma.memory.count({
      where: { userId, orgId, deletedAt: null, tags: { hasSome: ['synthesis:bridge'] } },
    });
    // Count revisions > 1 before
    const revBefore = await prisma.memory.count({
      where: {
        userId, orgId, isLatest: true, deletedAt: null,
        synthesisRevision: { gt: 1 },
        synthesisClusterHash: { not: null },
      },
    });

    try {
      await loop.synthesizeForOrg(orgId);
    } catch (err) {
      console.error(`  [backfill] synthesizeForOrg failed for user=${userId}: ${err.message}`);
    }

    const synthAfter = await prisma.memory.count({
      where: { userId, orgId, deletedAt: null, tags: { hasSome: ['synthesis:canonical'] } },
    });
    const bridgeAfter = await prisma.memory.count({
      where: { userId, orgId, deletedAt: null, tags: { hasSome: ['synthesis:bridge'] } },
    });
    const revAfter = await prisma.memory.count({
      where: {
        userId, orgId, isLatest: true, deletedAt: null,
        synthesisRevision: { gt: 1 },
        synthesisClusterHash: { not: null },
      },
    });

    canonical_facts_created = Math.max(0, synthAfter  - synthBefore);
    bridges_created         = Math.max(0, bridgeAfter - bridgeBefore);
    revisions_bumped        = Math.max(0, revAfter    - revBefore);

    const result = {
      user_id: userId,
      clusters_found:          canonical_facts_created + bridges_created + revisions_bumped,
      canonical_facts_created,
      bridges_created,
      revisions_bumped,
    };
    console.log('  result:', JSON.stringify(result));
    results.push(result);
  }

  console.log('\n[backfill] summary:');
  console.table(results);

  await prisma.$disconnect();
  console.log('[backfill] done');
}

main().catch(err => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});

#!/usr/bin/env node
/**
 * cognition-loop-backfill.mjs — Phase 1 Cognition Loop backfill
 *
 * Re-runs the Phase 1 synthesis pass (tag-intersection clustering + bridge
 * detection) against ALL existing memories for a given org, not just the
 * last-24h window used by the hourly cron. Use to bootstrap synthesis
 * memories on a fresh deploy or after the cluster-purge.
 *
 * Usage:
 *   ORG_ID=<uuid> node /app/scripts/cognition-loop-backfill.mjs
 *   # Dry-run (no writes):
 *   DRY_RUN=true ORG_ID=<uuid> node /app/scripts/cognition-loop-backfill.mjs
 *
 * Runs inside the container so all env vars are available.
 * Safe to re-run: 6h cooldown per cluster_hash prevents duplicate synthesis.
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const ORG_ID  = process.env.ORG_ID;
const DRY_RUN = process.env.DRY_RUN === 'true';

if (!ORG_ID) {
  console.error('ORG_ID env var required');
  process.exit(1);
}

async function main() {
  console.log(`[backfill] org=${ORG_ID} dry_run=${DRY_RUN}`);

  // Dynamic import so this script works inside the container at /app/
  // where graph-engine.js and server.js are already loaded.
  // We import CognitionLoop and wire it up with a minimal stub engine.
  const { CognitionLoop } = await import('../src/memory/cognition-loop.js');
  const { PrismaGraphStore } = await import('../src/memory/prisma-graph-store.js');

  const store = new PrismaGraphStore({ prisma });

  // Stub engine: if DRY_RUN skip actual writes
  const engineStub = DRY_RUN
    ? {
        ingestMemory: async (payload) => {
          console.log(`[DRY_RUN] would ingest: ${payload.title}`);
          return null;
        },
      }
    : null; // null → CognitionLoop falls back to direct Prisma insert

  const loop = new CognitionLoop({
    prisma,
    memoryGraphEngine: engineStub,
    persistentMemoryStore: store,
    logger: console,
  });

  // Temporarily extend lookback to cover ALL memories (365d)
  const originalLookback = process.env.SYNTHESIS_LOOKBACK_HOURS;
  process.env.SYNTHESIS_LOOKBACK_HOURS = String(365 * 24);

  console.log('[backfill] running synthesizeForOrg...');
  const synth = await loop.synthesizeForOrg(ORG_ID);
  console.log(`[backfill] synthesized ${synth} memories`);

  // Restore
  if (originalLookback) process.env.SYNTHESIS_LOOKBACK_HOURS = originalLookback;
  else delete process.env.SYNTHESIS_LOOKBACK_HOURS;

  await prisma.$disconnect();
  console.log('[backfill] done');
}

main().catch(err => {
  console.error('[backfill] fatal:', err);
  process.exit(1);
});

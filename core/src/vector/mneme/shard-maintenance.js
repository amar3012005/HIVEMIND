// Compaction for .amr shards — Phase A (production-trust gate) item 1.
//
// The native `MnemeStore.compact()` binding has existed since P3 but nothing in the JS layer ever
// called it: inserts/rewrites are append-only, so `.txt`/`.edg` grow forever even as tombstoned/
// superseded slots and overflow blocks accumulate dead bytes. Confirmed live: a shard with 11 live
// memories held a 4.2MB `.vec` file — pure accumulated waste, not signal.
//
// compact() is synchronous and blocks the Node event loop for its full duration (it rewrites
// `.txt`/`.edg` start-to-finish via temp-file+rename — see mneme/crate/mseg/src/segment.rs). That
// makes it a background-job concern, not something to call inline on a request path: run it
// per-org, low frequency, one org at a time (never in parallel — Node is single-threaded anyway,
// but this keeps intent explicit), with a per-org try/catch so one org's failure never blocks the
// rest of the sweep.
import { listOpenShards } from './embedded-agent.mjs';

// Only compact a shard we haven't touched in at least this long — a job tick every few minutes
// should not re-compact the same org every time it fires. Per-org, in-memory (best-effort; a
// restart just means the next sweep re-evaluates everyone, which is harmless).
const MIN_INTERVAL_MS = Number(process.env.MNEME_COMPACT_MIN_INTERVAL_MS || 6 * 60 * 60 * 1000); // 6h
const lastCompactedAt = new Map(); // orgId -> epoch ms

export async function runShardCompaction({ logger = console } = {}) {
  const shards = listOpenShards();
  const now = Date.now();
  let attempted = 0;
  let reclaimedTotal = 0;
  for (const { orgId, ctx } of shards) {
    const last = lastCompactedAt.get(orgId) || 0;
    if (now - last < MIN_INTERVAL_MS) continue;
    attempted++;
    try {
      const reclaimed = ctx.amr.compact();
      lastCompactedAt.set(orgId, now);
      reclaimedTotal += Number(reclaimed) || 0;
      if (reclaimed) {
        logger?.log?.(`[amr-compact] org=${orgId} reclaimed=${Math.round(reclaimed)}B`);
      }
    } catch (err) {
      // Per-org isolation: one shard's compaction failure must not stop the sweep or take down
      // the process — recall/write on that org still works uncompacted, just keeps growing.
      logger?.warn?.(`[amr-compact] org=${orgId} failed: ${err?.message || err}`);
    }
  }
  return { shardsOpen: shards.length, attempted, reclaimedTotal };
}

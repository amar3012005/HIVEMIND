// Point-in-time snapshot/restore for .amr shards — Phase A (production-trust gate) item: a dead
// box currently means that org's memory is offline permanently (no HA, no backup path at all).
// This is deliberately simple and synchronous, not a general backup framework:
//
//   - snapshotOrg(): flush() the shard (if it's open in this process) so every file on disk is in
//     the crash-safe, self-consistent state segment.rs's flush() guarantees, THEN a SYNCHRONOUS
//     directory copy (fs.cpSync). Synchronous is the point — it does not yield the event loop
//     mid-copy, so no write to that org can land between "flushed" and "copied" (Node is single-
//     threaded; a sync call can't be interleaved with another JS-issued native call). An async
//     copy (fs.promises.cp) would NOT have this guarantee, since the event loop can run another
//     request's insert()/flush() in the gap between await'd copy steps.
//   - shard.lock is NEVER copied in either direction: it is a per-OPEN flock, not shard state,
//     and a stale lock file in a restore target makes Shard::open's flock(LOCK_EX|LOCK_NB) fail
//     with "shard is locked" even though nothing is actually holding it.
//   - restoreOrg() refuses to run against a currently-open shard in THIS process (would corrupt
//     a live mmap) and refuses if a lock file already exists at the target (another process may
//     hold it) — restore is an offline operation by design, not a live-swap.
import fs from 'fs';
import path from 'path';
import { listOpenShards } from './embedded-agent.mjs';

const DATA_ROOT = process.env.MNEME_DATA_ROOT || '/app/data/mneme';
const LOCK_BASENAME = 'shard.lock';

function orgDirName(orgId) {
  return String(orgId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

function skipLockFilter(src) {
  return path.basename(src) !== LOCK_BASENAME;
}

// Flush orgId's shard first IF it's open in this process, so the copy below is guaranteed to see
// the crash-safe, fully-committed file set — not a stray partial write mid-flight. If the shard
// isn't open here (e.g. a dedicated backup process, or this org hasn't been touched yet), the
// files are still only ever mutated via flush()'d writes (amr-store.mjs flushes after every
// mutating call), so a copy of a not-currently-open shard is safe too — there's no other writer.
function flushIfOpen(orgId) {
  const open = listOpenShards().find((s) => s.orgId === orgId);
  if (open) {
    try { open.ctx.amr.store.flush(); } catch { /* best-effort — copy proceeds regardless */ }
  }
  return !!open;
}

/**
 * Snapshot one org's shard directory to `destDir` (must not already exist). Returns the org's
 * live count at snapshot time (0 if the shard has never been opened — nothing to back up).
 */
export function snapshotOrg(orgId, { dataRoot = DATA_ROOT, destDir } = {}) {
  if (!destDir) throw new Error('snapshotOrg: destDir required');
  const srcDir = path.join(dataRoot, orgDirName(orgId));
  if (!fs.existsSync(srcDir)) return { orgId, backedUp: false, reason: 'no shard directory yet' };
  flushIfOpen(orgId);
  fs.mkdirSync(path.dirname(destDir), { recursive: true });
  fs.cpSync(srcDir, destDir, { recursive: true, filter: skipLockFilter, errorOnExist: true });
  const files = fs.readdirSync(destDir);
  return { orgId, backedUp: true, destDir, files };
}

/**
 * Restore one org's shard directory FROM `srcSnapshotDir` INTO the live dataRoot. Refuses if the
 * shard is currently open in this process, or if a lock file already exists at the target (either
 * case means it may be in active use — restore is an offline recovery operation, run it against a
 * dataRoot no live process is currently serving that org from).
 */
export function restoreOrg(orgId, { dataRoot = DATA_ROOT, srcSnapshotDir } = {}) {
  if (!srcSnapshotDir) throw new Error('restoreOrg: srcSnapshotDir required');
  if (!fs.existsSync(srcSnapshotDir)) throw new Error(`restoreOrg: snapshot not found at ${srcSnapshotDir}`);
  const open = listOpenShards().find((s) => s.orgId === orgId);
  if (open) throw new Error(`restoreOrg: org ${orgId} shard is open in this process — close/evict it first`);
  const destDir = path.join(dataRoot, orgDirName(orgId));
  if (fs.existsSync(path.join(destDir, LOCK_BASENAME))) {
    throw new Error(`restoreOrg: ${destDir} has a lock file present — another process may hold this shard`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.cpSync(srcSnapshotDir, destDir, { recursive: true, filter: skipLockFilter, force: true });
  return { orgId, restored: true, destDir };
}

/** Snapshot every currently-open shard to `backupRoot/<orgId>-<timestampMs>/`. Best-effort per org. */
export function snapshotAllOpenShards({ dataRoot = DATA_ROOT, backupRoot, logger = console } = {}) {
  if (!backupRoot) throw new Error('snapshotAllOpenShards: backupRoot required');
  const results = [];
  for (const { orgId } of listOpenShards()) {
    const destDir = path.join(backupRoot, `${orgDirName(orgId)}-${Date.now()}`);
    try {
      results.push(snapshotOrg(orgId, { dataRoot, destDir }));
    } catch (err) {
      logger?.warn?.(`[amr-backup] org=${orgId} failed: ${err?.message || err}`);
      results.push({ orgId, backedUp: false, reason: err?.message || String(err) });
    }
  }
  return results;
}

// Retention: a snapshot job run on every tick with no cleanup grows disk unboundedly (every
// snapshot is a full copy). Keep only the newest `keep` snapshots per org, delete the rest. Safe
// to call even if a snapshot in the list is mid-write from a differently-timed job (unlikely given
// the scheduler is single-flight per process, but directory removal only targets OLD timestamped
// dirs, never the one just created).
export function pruneOldSnapshots({ backupRoot, keep = 3, logger = console } = {}) {
  if (!backupRoot || !fs.existsSync(backupRoot)) return [];
  const entries = fs.readdirSync(backupRoot, { withFileTypes: true }).filter((e) => e.isDirectory());
  const byOrg = new Map(); // orgDirPrefix -> [{ name, ts }]
  for (const e of entries) {
    const m = e.name.match(/^(.*)-(\d+)$/);
    if (!m) continue;
    const [, org, ts] = m;
    if (!byOrg.has(org)) byOrg.set(org, []);
    byOrg.get(org).push({ name: e.name, ts: Number(ts) });
  }
  const removed = [];
  for (const [, list] of byOrg) {
    list.sort((a, b) => b.ts - a.ts); // newest first
    for (const stale of list.slice(keep)) {
      const p = path.join(backupRoot, stale.name);
      try {
        fs.rmSync(p, { recursive: true, force: true });
        removed.push(p);
      } catch (err) {
        logger?.warn?.(`[amr-backup] prune failed for ${p}: ${err?.message || err}`);
      }
    }
  }
  return removed;
}

/**
 * `.amr` shard maintenance — snapshot + compaction (ICARUS Phase A, the trust gate).
 *
 * WHY THIS EXISTS
 *   The `.amr` shard is the SOLE copy of an org's memories (records, vectors, text,
 *   graph edges). Two Phase-A gaps were measured on the live box:
 *     1. NOTHING backed a shard up — a dead box meant that org's memory was gone
 *        for good ("losing data once → dead forever for anyone serious").
 *     2. The native `compact()` had ZERO call sites, so append-only growth was
 *        unbounded — 4.2 MB of `shard.vec` for 11 live memories.
 *
 * ORDER IS THE SAFETY PROPERTY
 *   Snapshot ALWAYS runs before compaction, and a slot is only compacted if THIS
 *   pass captured a snapshot of it. Compaction rewrites the slot; doing that to an
 *   unbacked file is exactly the irreversible move Phase A exists to prevent.
 *
 * HONEST SCOPE
 *   This is a WARM snapshot, not a WAL or a standby. The engine flushes on write,
 *   so a copy taken between writes is a consistent prefix; a copy taken mid-append
 *   may catch a partial tail (the format tolerates it on open). It turns a box loss
 *   from permanent data loss into restore-from-last-snapshot. A flush-fenced
 *   snapshot, an offsite target, and WAL/standby remain the Phase-A follow-ups.
 *
 * FLAGS
 *   MNEME_BACKUP_ENABLED   default 'true'  — snapshot sweep
 *   MNEME_COMPACT_ENABLED  default 'false' — compaction is OPT-IN: it rewrites data,
 *                                            so it stays off until backups are proven
 *   MNEME_BACKUP_ROOT      default <dataRoot>/../mneme-backups
 *   MNEME_BACKUP_KEEP      default 8       — snapshots retained per org
 *
 * RESTORE: stop the process, copy a snapshot dir's files back over the slot, start.
 *
 * @module src/vector/mneme/shard-maintenance
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

/** Files that constitute a slot. `shard.lock` is deliberately NOT copied. */
const SHARD_FILES = ['shard.amr', 'shard.vec', 'shard.txt', 'shard.edg'];

const isOn = (v, dflt) => String(process.env[v] ?? dflt).toLowerCase() === 'true';

/**
 * One snapshot pass over every slot under dataRoot.
 * @returns {{slots:number,snapped:number,pruned:number,failed:number,bytes:number,orgs:string[]}}
 *          `orgs` = slots successfully snapshotted in THIS pass (the compaction allowlist).
 */
export function snapshotShardsOnce({
  dataRoot = process.env.MNEME_DATA_ROOT || '/app/data/mneme',
  backupRoot = process.env.MNEME_BACKUP_ROOT || null,
  keep = Math.max(1, Number(process.env.MNEME_BACKUP_KEEP || 8)),
  stamp = null,
  logger = console,
} = {}) {
  const root = backupRoot || path.join(path.dirname(dataRoot), 'mneme-backups');
  const stats = { slots: 0, snapped: 0, pruned: 0, failed: 0, bytes: 0, orgs: [] };

  let entries = [];
  try {
    entries = fs.readdirSync(dataRoot, { withFileTypes: true })
      .filter((d) => d.isDirectory()).map((d) => d.name);
  } catch { return stats; }

  // Injectable for tests; production uses wall-clock. ISO stamps sort lexically = chronologically.
  const ts = stamp || new Date().toISOString().replace(/[:.]/g, '-');

  for (const org of entries) {
    const src = path.join(dataRoot, org);
    const present = SHARD_FILES.filter((f) => {
      try { return fs.existsSync(path.join(src, f)); } catch { return false; }
    });
    if (!present.includes('shard.amr')) continue; // not a live slot
    stats.slots += 1;

    const orgBackupDir = path.join(root, org);
    const dst = path.join(orgBackupDir, ts);
    try {
      fs.mkdirSync(dst, { recursive: true, mode: 0o700 });
      let bytes = 0;
      for (const f of present) {
        const from = path.join(src, f);
        const to = path.join(dst, f);
        // `shard.vec` is SPARSE — 4 MB apparent, almost nothing allocated. A plain
        // fs.copyFileSync FILLS THE HOLES: measured on prod, 5.4 MB of live slots
        // produced 35 MB per snapshot (6.5x), which then multiplies by the retention
        // count. Node has no sparse-aware copy, and COPYFILE_FICLONE only helps on
        // CoW filesystems (the box is ext4, where it just throws). GNU cp does know
        // how to detect holes, so use it when present and fall back to the plain
        // copy everywhere else — correctness never depends on cp existing.
        let copied = false;
        if (process.platform === 'linux') {
          try { execFileSync('cp', ['--sparse=always', from, to], { stdio: 'ignore' }); copied = true; }
          catch { /* no GNU cp (or it failed) — fall through to the portable copy */ }
        }
        if (!copied) fs.copyFileSync(from, to);
        // Count ALLOCATED bytes (blocks*512), not apparent size, so the log reports the
        // real footprint rather than the sparse illusion.
        try { const st = fs.statSync(to); bytes += (st.blocks != null ? st.blocks * 512 : st.size); }
        catch { /* size is best-effort */ }
      }
      // Write the manifest LAST: its presence is what marks a snapshot complete, so a
      // half-copied dir (process killed mid-sweep) is never mistaken for a restore point.
      fs.writeFileSync(
        path.join(dst, 'MANIFEST.json'),
        JSON.stringify({ org, ts, files: present, bytes, warm: true, complete: true }, null, 2),
        { mode: 0o600 },
      );
      stats.snapped += 1;
      stats.bytes += bytes;
      stats.orgs.push(org);

      // Retention: keep the newest `keep` COMPLETE snapshots, drop the rest.
      let existing = [];
      try {
        existing = fs.readdirSync(orgBackupDir)
          .filter((n) => /^\d{4}-/.test(n))
          .filter((n) => fs.existsSync(path.join(orgBackupDir, n, 'MANIFEST.json')));
      } catch { existing = []; }
      for (const old of existing.sort().slice(0, Math.max(0, existing.length - keep))) {
        try { fs.rmSync(path.join(orgBackupDir, old), { recursive: true, force: true }); stats.pruned += 1; }
        catch { /* best-effort prune */ }
      }
    } catch (e) {
      stats.failed += 1;
      logger.warn?.(`[shard-backup] slot ${String(org).slice(0, 8)} failed: ${e.message}`);
    }
  }

  if (stats.snapped || stats.failed) {
    logger.info?.(`[shard-backup] slots=${stats.slots} snapped=${stats.snapped} pruned=${stats.pruned} `
      + `failed=${stats.failed} bytes=${stats.bytes}`);
  }
  return stats;
}

/**
 * One maintenance pass: snapshot, then compact ONLY slots this pass backed up.
 * @returns {Promise<{backup:object,compact:object|null}>}
 */
export async function runShardMaintenanceOnce({ logger = console } = {}) {
  const out = { backup: null, mirror: null, compact: null };

  out.backup = isOn('MNEME_BACKUP_ENABLED', 'true')
    ? snapshotShardsOnce({ logger })
    : { slots: 0, snapped: 0, pruned: 0, failed: 0, bytes: 0, orgs: [] };

  // ── SQL-mirror backfill ───────────────────────────────────────────────────
  // /v1/lexical (the lexical half of hybrid recall) runs Postgres FTS over the
  // `memories` mirror, not the shard. /v1/write mirrors new records, but memories
  // written before that mirror existed were never backfilled — measured on prod,
  // 6 of 7 amr_embedded orgs had ZERO mirror rows against shards holding real data,
  // so those tenants were silently running vector-only recall. Additive and
  // idempotent (ON CONFLICT DO NOTHING), so it is safe to run on every pass.
  if (isOn('MNEME_MIRROR_BACKFILL_ENABLED', 'true') && (out.backup.orgs || []).length) {
    out.mirror = { orgs: 0, inserted: 0, failed: 0 };
    try {
      const { backfillSqlMirror } = await import('./embedded-agent.mjs');
      for (const org of out.backup.orgs) {
        // eslint-disable-next-line no-await-in-loop
        const r = await backfillSqlMirror(org, { logger });
        out.mirror.orgs += 1;
        out.mirror.inserted += r.inserted;
        out.mirror.failed += r.failed;
        if (r.inserted || r.failed) {
          logger.info?.(`[mirror-backfill] org=${String(org).slice(0, 8)} shard=${r.shard} `
            + `existing=${r.existing} inserted=${r.inserted} failed=${r.failed}`);
        }
      }
      if (out.mirror.inserted || out.mirror.failed) {
        logger.info?.(`[mirror-backfill] orgs=${out.mirror.orgs} inserted=${out.mirror.inserted} `
          + `failed=${out.mirror.failed} — lexical recall restored for backfilled rows`);
      }
    } catch (e) {
      logger.warn?.(`[mirror-backfill] pass failed: ${e.message}`);
    }
  }

  if (!isOn('MNEME_COMPACT_ENABLED', 'false')) return out;

  // Compaction rewrites the slot — only touch what was just snapshotted.
  const backedUp = new Set(out.backup.orgs || []);
  if (!backedUp.size) {
    logger.warn?.('[shard-compact] skipped — no slot was snapshotted this pass (never compact unbacked data)');
    return out;
  }
  try {
    const { compactShards } = await import('./embedded-agent.mjs');
    // Slot dirs ARE the sanitised org ids, so they round-trip straight back to getCtx.
    out.compact = await compactShards([...backedUp], { logger });
    const c = out.compact;
    // Log EVERY pass, including a no-op one. The previous version only logged when
    // something was attempted, so a job that never fired looked identical to a job
    // that had nothing to do — which is exactly how it went unnoticed for an hour.
    logger.info?.(`[shard-compact] eligible=${backedUp.size} attempted=${c.attempted} `
      + `compacted=${c.compacted} failed=${c.failed} skipped_cooldown=${c.skipped} `
      + `reclaimed=${c.reclaimed}`);
  } catch (e) {
    logger.warn?.(`[shard-compact] pass failed: ${e.message}`);
  }
  return out;
}

export default runShardMaintenanceOnce;

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

const RUNTIME_PROGRESS_VERBOSE = String(process.env.RUNTIME_PROGRESS_VERBOSE || '').toLowerCase() === 'true';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/** Files that constitute a slot. `shard.lock` is deliberately NOT copied. */
const SHARD_FILES = ['shard.amr', 'shard.vec', 'shard.txt', 'shard.edg'];

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read = 0;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/**
 * Verify a completed shard snapshot without opening or mutating the live shard.
 * A manifest is the restore boundary: every declared file must exist, match its
 * byte length and SHA-256 digest, and shard.amr must be present.
 */
export function verifyShardSnapshot(snapshotDir) {
  const manifestPath = path.join(snapshotDir, 'MANIFEST.json');
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); }
  catch (error) { return { ok: false, error: `manifest_unreadable:${error.message}` }; }

  if (manifest?.complete !== true || !Array.isArray(manifest.files)
      || !manifest.files.includes('shard.amr')) {
    return { ok: false, error: 'manifest_incomplete' };
  }
  if (Number(manifest.version || 0) < 2 || !manifest.artifacts) {
    return { ok: false, error: 'manifest_unverifiable' };
  }

  for (const file of manifest.files) {
    if (!SHARD_FILES.includes(file)) return { ok: false, error: `unexpected_file:${file}` };
    const artifact = manifest.artifacts[file];
    if (!artifact || !Number.isSafeInteger(artifact.bytes) || !/^[a-f0-9]{64}$/.test(artifact.sha256 || '')) {
      return { ok: false, error: `artifact_metadata_invalid:${file}` };
    }
    const target = path.join(snapshotDir, file);
    try {
      const stat = fs.statSync(target);
      if (!stat.isFile() || stat.size !== artifact.bytes) return { ok: false, error: `size_mismatch:${file}` };
      if (sha256File(target) !== artifact.sha256) return { ok: false, error: `checksum_mismatch:${file}` };
    } catch (error) {
      return { ok: false, error: `artifact_unreadable:${file}:${error.message}` };
    }
  }
  return { ok: true, org: manifest.org, ts: manifest.ts, files: manifest.files.length };
}

/**
 * Verify that a snapshot has an upload acknowledgement bound to its exact
 * manifest and encrypted portable bundle. The uploader is responsible for
 * returning success only after the remote object checksum has been verified.
 */
export function verifyOffsiteReceipt(snapshotDir) {
  const receiptPath = path.join(snapshotDir, 'OFFSITE_RECEIPT.json');
  let receipt;
  try { receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8')); }
  catch (error) { return { ok: false, error: `receipt_unreadable:${error.message}` }; }
  if (receipt?.complete !== true || !/^[a-f0-9]{64}$/.test(receipt.bundle_sha256 || '')
      || !/^[a-f0-9]{64}$/.test(receipt.snapshot_manifest_sha256 || '')
      || typeof receipt.target !== 'string' || !receipt.target.trim()
      || !Number.isFinite(Date.parse(receipt.uploaded_at || ''))) {
    return { ok: false, error: 'receipt_invalid' };
  }
  if (sha256File(path.join(snapshotDir, 'MANIFEST.json')) !== receipt.snapshot_manifest_sha256) {
    return { ok: false, error: 'receipt_manifest_mismatch' };
  }
  return { ok: true, target: receipt.target, uploaded_at: receipt.uploaded_at };
}

const isOn = (v, dflt) => String(process.env[v] ?? dflt).toLowerCase() === 'true';
const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function uploadSnapshotsOffsite(snapshots = [], {
  enabled = isOn('MNEME_OFFSITE_UPLOAD_ENABLED', 'false'),
  runner = execFileSync,
  logger = console,
} = {}) {
  const out = { attempted: 0, uploaded: 0, failed: 0, orgs: [] };
  if (!enabled) return out;
  const uploader = path.resolve(MODULE_DIR, '../../../scripts/amr-offsite-upload.sh');
  for (const snapshot of snapshots) {
    out.attempted += 1;
    try {
      runner('bash', [uploader, snapshot.path], { env: process.env, stdio: 'pipe' });
      const receipt = verifyOffsiteReceipt(snapshot.path);
      if (!receipt.ok) throw new Error(receipt.error);
      out.uploaded += 1;
      out.orgs.push(snapshot.org);
    } catch (error) {
      out.failed += 1;
      logger.warn?.(`[shard-offsite] slot ${String(snapshot.org).slice(0, 8)} failed: ${error.message}`);
    }
  }
  if (out.attempted) logger.info?.(`[shard-offsite] attempted=${out.attempted} uploaded=${out.uploaded} failed=${out.failed}`);
  return out;
}

export function offsiteEligibleOrgs(snapshots = []) {
  return snapshots
    .filter((snapshot) => verifyOffsiteReceipt(snapshot.path).ok)
    .map((snapshot) => snapshot.org);
}

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
  const stats = { slots: 0, snapped: 0, pruned: 0, failed: 0, bytes: 0, orgs: [], snapshots: [] };

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
    const staging = path.join(orgBackupDir, `.${ts}.partial-${process.pid}`);
    try {
      fs.rmSync(staging, { recursive: true, force: true });
      fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
      let bytes = 0;
      const artifacts = {};
      for (const f of present) {
        const from = path.join(src, f);
        const to = path.join(staging, f);
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
        try {
          const st = fs.statSync(to);
          bytes += (st.blocks != null ? st.blocks * 512 : st.size);
          artifacts[f] = { bytes: st.size, sha256: sha256File(to) };
        }
        catch { /* size is best-effort */ }
      }
      // Write the manifest LAST: its presence is what marks a snapshot complete, so a
      // half-copied dir (process killed mid-sweep) is never mistaken for a restore point.
      fs.writeFileSync(
        path.join(staging, 'MANIFEST.json'),
        JSON.stringify({ version: 2, org, ts, files: present, artifacts, bytes, warm: true, complete: true }, null, 2),
        { mode: 0o600 },
      );
      const verified = verifyShardSnapshot(staging);
      if (!verified.ok) throw new Error(`snapshot verification failed: ${verified.error}`);
      fs.rmSync(dst, { recursive: true, force: true });
      fs.renameSync(staging, dst);
      stats.snapped += 1;
      stats.bytes += bytes;
      stats.orgs.push(org);
      stats.snapshots.push({ org, path: dst });

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
      try { fs.rmSync(staging, { recursive: true, force: true }); } catch { /* best effort */ }
      stats.failed += 1;
      if (RUNTIME_PROGRESS_VERBOSE) {
        logger.warn?.(`[shard-backup] slot ${String(org).slice(0, 8)} failed: ${e.message}`);
      }
    }
  }

  if (RUNTIME_PROGRESS_VERBOSE && (stats.snapped || stats.failed)) {
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
  const out = {
    backup: null, offsite: null, mirror: null, docs: null,
    entities: null, provenance: null, evidence: null, compact: null,
  };

  out.backup = isOn('MNEME_BACKUP_ENABLED', 'true')
    ? snapshotShardsOnce({ logger })
    : { slots: 0, snapped: 0, pruned: 0, failed: 0, bytes: 0, orgs: [], snapshots: [] };

  // Upload the exact snapshot from this pass before any destructive operation.
  // The uploader writes a receipt only after its operator-owned remote command
  // returns success and the receipt is verified again here.
  out.offsite = uploadSnapshotsOffsite(out.backup.snapshots || [], { logger });

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
        if (RUNTIME_PROGRESS_VERBOSE && (r.inserted || r.failed)) {
          logger.info?.(`[mirror-backfill] org=${String(org).slice(0, 8)} shard=${r.shard} `
            + `existing=${r.existing} inserted=${r.inserted} failed=${r.failed}`);
        }
      }
      if (RUNTIME_PROGRESS_VERBOSE && (out.mirror.inserted || out.mirror.failed)) {
        logger.info?.(`[mirror-backfill] orgs=${out.mirror.orgs} inserted=${out.mirror.inserted} `
          + `failed=${out.mirror.failed} — lexical recall restored for backfilled rows`);
      }

      // Evidence, the other direction: Postgres+Qdrant -> shard. The kb-segment
      // dual-write only covers NEW ingests, so without this a slot never holds its
      // historical evidence and can never be read-compared against the current lane.
      // Additive and idempotent; no read path depends on it yet.
      // Documents -> shard (layer 'document'). These carry each document's owner, scope-key
      // grants and title: the shard-side half of the knowledge_documents join, and the thing a
      // shard-side access gate reads. The /v1/kb-doc dual-write only covers new ingests, so
      // without this pass a gate would have grants for recent documents and none for older ones —
      // and it fails closed, which would quietly hide a user's own older files.
      if (isOn('MNEME_DOC_BACKFILL_ENABLED', 'true')) {
        const { backfillDocsToShard } = await import('./embedded-agent.mjs');
        let dc = { pg: 0, written: 0, failed: 0 };
        for (const org of out.backup.orgs) {
          // eslint-disable-next-line no-await-in-loop
          const r = await backfillDocsToShard(org, { logger }).catch(() => null);
          if (!r) continue;
          dc.pg += r.pg; dc.written += r.written; dc.failed += r.failed;
        }
        out.docs = dc;
        if (dc.written || dc.failed) {
          if (RUNTIME_PROGRESS_VERBOSE) {
            logger.info?.(`[doc-backfill] docs=${dc.pg} written=${dc.written} failed=${dc.failed}`);
          }
        }
      }

      // Entities + provenance -> slot. These were the last two parts of a user's memory layer
      // still living only in Postgres: entity NAMES in the central table (a residency gap, not a
      // tidiness one) and "where did this claim come from" in hm.memory_evidence_links.
      if (isOn('MNEME_ENTITY_BACKFILL_ENABLED', 'true')) {
        const { backfillEntitiesToShard, backfillProvenanceToShard } = await import('./embedded-agent.mjs');
        let ent = { entities: 0, written: 0, edges: 0 };
        let prov = { pg: 0, written: 0, skipped: 0 };
        for (const org of out.backup.orgs) {
          // eslint-disable-next-line no-await-in-loop
          const e = await backfillEntitiesToShard(org, { logger }).catch(() => null);
          if (e) { ent.entities += e.entities; ent.written += e.written; ent.edges += e.edges; }
          // eslint-disable-next-line no-await-in-loop
          const p = await backfillProvenanceToShard(org, { logger }).catch(() => null);
          if (p) { prov.pg += p.pg; prov.written += p.written; prov.skipped += p.skipped; }
        }
        out.entities = ent;
        out.provenance = prov;
      }

      if (isOn('MNEME_EVIDENCE_BACKFILL_ENABLED', 'true')) {
        const { backfillEvidenceToShard } = await import('./embedded-agent.mjs');
        let ev = { written: 0, novector: 0, failed: 0, already: 0 };
        for (const org of out.backup.orgs) {
          // eslint-disable-next-line no-await-in-loop
          const r = await backfillEvidenceToShard(org, { logger }).catch(() => null);
          if (!r) continue;
          ev.written += r.written; ev.novector += r.novector;
          ev.failed += r.failed; ev.already += r.already;
        }
        out.evidence = ev;
        if (ev.written || ev.failed || ev.novector) {
          logger.info?.(`[evidence-backfill] written=${ev.written} already=${ev.already} `
            + `no_vector=${ev.novector} failed=${ev.failed}`);
        }

        // B4 step 2 — read-compare the two evidence lanes on REAL embeddings. Pure
        // measurement: it writes nothing and changes no behaviour. It exists so the
        // decision to flip /v1/kb-recall to the shard rests on a measured top-k
        // overlap rather than on the code looking correct.
        if (isOn('MNEME_EVIDENCE_READ_COMPARE', 'true')) {
          const { readCompareEvidence } = await import('./embedded-agent.mjs');
          for (const org of out.backup.orgs) {
            // eslint-disable-next-line no-await-in-loop
            await readCompareEvidence(org, { logger }).catch(() => null);
          }
        }
      }
    } catch (e) {
      logger.warn?.(`[mirror-backfill] pass failed: ${e.message}`);
    }
  }

  if (!isOn('MNEME_COMPACT_ENABLED', 'false')) return out;

  // Compaction rewrites the slot. A local snapshot protects against a bad
  // rewrite but not device loss, so eligibility requires a same-pass snapshot
  // whose encrypted portable bundle has an off-host receipt bound to the exact
  // manifest. Compaction stays fail-closed when upload is not configured.
  const backedUp = new Set(offsiteEligibleOrgs(out.backup.snapshots || []));
  if (!backedUp.size) {
    logger.warn?.('[shard-compact] skipped — no same-pass snapshot has a verified off-host receipt');
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

#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { verifyShardSnapshot } from '../src/vector/mneme/shard-maintenance.js';

function argsOf(argv) {
  const out = {
    dataRoot: process.env.MNEME_DATA_ROOT || '/app/data/mneme',
    backupRoot: process.env.MNEME_BACKUP_ROOT || '/app/data/mneme-backups',
    maxAgeHours: Number(process.env.MNEME_BACKUP_MAX_AGE_HOURS || 26),
    dim: Number(process.env.MNEME_DIM || 1024),
    verifyOpen: true,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--data-root') out.dataRoot = argv[++i];
    else if (arg === '--backup-root') out.backupRoot = argv[++i];
    else if (arg === '--max-age-hours') out.maxAgeHours = Number(argv[++i]);
    else if (arg === '--dim') out.dim = Number(argv[++i]);
    else if (arg === '--no-open') out.verifyOpen = false;
    else if (arg === '--help') out.help = true;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!Number.isFinite(out.maxAgeHours) || out.maxAgeHours <= 0) throw new Error('max age must be positive');
  if (!Number.isInteger(out.dim) || out.dim <= 0) throw new Error('dimension must be a positive integer');
  return out;
}

function tenantRef(org) {
  return crypto.createHash('sha256').update(String(org)).digest('hex').slice(0, 12);
}

function newestVerifiedSnapshot(backupRoot, org) {
  const orgRoot = path.join(backupRoot, org);
  let dirs = [];
  try {
    dirs = fs.readdirSync(orgRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort().reverse();
  } catch { return { ok: false, error: 'backup_missing' }; }
  let firstError = null;
  for (const name of dirs) {
    const dir = path.join(orgRoot, name);
    const result = verifyShardSnapshot(dir);
    if (result.ok) {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'MANIFEST.json'), 'utf8'));
      const mtimeMs = fs.statSync(path.join(dir, 'MANIFEST.json')).mtimeMs;
      return { ok: true, dir, mtimeMs, files: manifest.files };
    }
    firstError ||= result.error;
  }
  return { ok: false, error: firstError || 'verified_backup_missing' };
}

export async function runAmrDoctor(options) {
  let orgs = [];
  try {
    orgs = fs.readdirSync(options.dataRoot, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((org) => fs.existsSync(path.join(options.dataRoot, org, 'shard.amr')));
  } catch (error) {
    return { ok: false, error: `data_root_unreadable:${error.message}`, slots: [] };
  }

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-doctor-'));
  const results = [];
  let Store = null;
  try {
    if (options.verifyOpen) {
      if (options.StoreClass) Store = options.StoreClass;
      else ({ AmrMemoryStore: Store } = await import('../src/vector/mneme/amr-store.mjs'));
    }
    for (const org of orgs.sort()) {
      const row = { tenant_ref: tenantRef(org), verified: false, fresh: false, opened: !options.verifyOpen, live_count: null };
      const snapshot = newestVerifiedSnapshot(options.backupRoot, org);
      if (!snapshot.ok) {
        row.error = snapshot.error;
        results.push(row);
        continue;
      }
      row.verified = true;
      row.age_hours = Math.max(0, Math.floor((Date.now() - snapshot.mtimeMs) / 3_600_000));
      row.fresh = row.age_hours <= options.maxAgeHours;
      if (!row.fresh) row.error = 'backup_stale';
      if (options.verifyOpen) {
        const isolatedOrg = `restore_${row.tenant_ref}`;
        const isolated = path.join(temp, isolatedOrg);
        fs.mkdirSync(isolated, { recursive: true, mode: 0o700 });
        for (const file of snapshot.files) fs.copyFileSync(path.join(snapshot.dir, file), path.join(isolated, file));
        try {
          const store = new Store({ dataRoot: temp, org: isolatedOrg, dim: options.dim });
          row.live_count = store.liveCount();
          row.opened = true;
          if (row.live_count < 1) row.error = 'restored_shard_empty';
        } catch (error) {
          row.error = `restore_open_failed:${error.message}`;
        }
      }
      results.push(row);
    }
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
  const partial_snapshots = (() => {
    let count = 0;
    try {
      for (const org of fs.readdirSync(options.backupRoot)) {
        const orgRoot = path.join(options.backupRoot, org);
        if (!fs.statSync(orgRoot).isDirectory()) continue;
        count += fs.readdirSync(orgRoot).filter((name) => name.includes('.partial-')).length;
      }
    } catch { /* reported through slot failures */ }
    return count;
  })();
  const failed = results.filter((row) => row.error).length;
  return { ok: orgs.length > 0 && failed === 0 && partial_snapshots === 0, slot_count: orgs.length, failed, partial_snapshots, slots: results };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const options = argsOf(process.argv.slice(2));
    if (options.help) {
      process.stdout.write('Usage: amr-doctor.mjs [--data-root DIR] [--backup-root DIR] [--max-age-hours N] [--dim N] [--no-open]\n');
    } else {
      const result = await runAmrDoctor(options);
      process.stdout.write(`${JSON.stringify(result)}\n`);
      if (!result.ok) process.exitCode = 1;
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

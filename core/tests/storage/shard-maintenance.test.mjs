import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  offsiteEligibleOrgs, runShardMaintenanceOnce, snapshotShardsOnce, uploadSnapshotsOffsite,
  verifyOffsiteReceipt, verifyShardSnapshot,
} from '../../src/vector/mneme/shard-maintenance.js';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const OFFSITE_SCRIPT = path.resolve(TEST_DIR, '../../scripts/amr-offsite-upload.sh');

function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-shard-backup-'));
  const dataRoot = path.join(root, 'mneme');
  const backupRoot = path.join(root, 'backups');
  const org = 'tenant-a';
  const shard = path.join(dataRoot, org);
  fs.mkdirSync(shard, { recursive: true });
  fs.writeFileSync(path.join(shard, 'shard.amr'), 'records');
  fs.writeFileSync(path.join(shard, 'shard.vec'), 'vectors');
  fs.writeFileSync(path.join(shard, 'shard.txt'), 'text');
  fs.writeFileSync(path.join(shard, 'shard.edg'), 'edges');
  return { root, dataRoot, backupRoot, org };
}

test('snapshot is staged, checksummed, and independently verifiable', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const stamp = '2026-08-17T12-00-00-000Z';

  const result = snapshotShardsOnce({ dataRoot: f.dataRoot, backupRoot: f.backupRoot, stamp, logger: {} });
  assert.equal(result.snapped, 1);
  assert.equal(result.failed, 0);

  const snapshot = path.join(f.backupRoot, f.org, stamp);
  assert.deepEqual(verifyShardSnapshot(snapshot), { ok: true, org: f.org, ts: stamp, files: 4 });
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshot, 'MANIFEST.json'), 'utf8'));
  assert.equal(manifest.version, 2);
  assert.match(manifest.artifacts['shard.amr'].sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readdirSync(path.join(f.backupRoot, f.org)).some((name) => name.includes('.partial-')), false);
});

test('verification fails closed after snapshot corruption', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const stamp = '2026-08-17T12-01-00-000Z';
  snapshotShardsOnce({ dataRoot: f.dataRoot, backupRoot: f.backupRoot, stamp, logger: {} });

  const snapshot = path.join(f.backupRoot, f.org, stamp);
  fs.appendFileSync(path.join(snapshot, 'shard.txt'), '-corrupt');
  assert.equal(verifyShardSnapshot(snapshot).ok, false);
  assert.match(verifyShardSnapshot(snapshot).error, /size_mismatch|checksum_mismatch/);
});

test('legacy manifest is not accepted as cryptographically verified', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-shard-legacy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'shard.amr'), 'records');
  fs.writeFileSync(path.join(root, 'MANIFEST.json'), JSON.stringify({ complete: true, files: ['shard.amr'] }));
  assert.deepEqual(verifyShardSnapshot(root), { ok: false, error: 'manifest_unverifiable' });
});

test('off-host receipt is bound to the exact verified snapshot manifest', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const stamp = '2026-08-17T12-02-00-000Z';
  snapshotShardsOnce({ dataRoot: f.dataRoot, backupRoot: f.backupRoot, stamp, logger: {} });
  const snapshot = path.join(f.backupRoot, f.org, stamp);
  const manifestHash = crypto.createHash('sha256')
    .update(fs.readFileSync(path.join(snapshot, 'MANIFEST.json'))).digest('hex');
  fs.writeFileSync(path.join(snapshot, 'OFFSITE_RECEIPT.json'), JSON.stringify({
    version: 1,
    complete: true,
    uploaded_at: '2026-08-17T12:03:00Z',
    target: 'test-offsite',
    bundle_sha256: 'a'.repeat(64),
    snapshot_manifest_sha256: manifestHash,
  }));
  assert.equal(verifyOffsiteReceipt(snapshot).ok, true);
  assert.deepEqual(offsiteEligibleOrgs([{ org: f.org, path: snapshot }]), [f.org]);

  fs.appendFileSync(path.join(snapshot, 'MANIFEST.json'), ' ');
  assert.deepEqual(verifyOffsiteReceipt(snapshot), { ok: false, error: 'receipt_manifest_mismatch' });
  assert.deepEqual(offsiteEligibleOrgs([{ org: f.org, path: snapshot }]), []);
});

test('off-host uploader exposes only the encrypted bundle and writes receipt after checksum proof', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const stamp = '2026-08-17T12-04-00-000Z';
  snapshotShardsOnce({ dataRoot: f.dataRoot, backupRoot: f.backupRoot, stamp, logger: {} });
  const snapshot = path.join(f.backupRoot, f.org, stamp);
  const remote = path.join(f.root, 'remote.hmamr');
  const helper = path.join(f.root, 'upload.sh');
  fs.writeFileSync(helper, `#!/usr/bin/env bash
set -eu
[ -z "\${AMR_EXPORT_PASSPHRASE:-}" ]
cp "$BACKUP_PATH" "$REMOTE_PATH"
printf '%s  %s\\n' "$BUNDLE_SHA256" "$REMOTE_PATH" | sha256sum -c - >/dev/null
`);
  fs.chmodSync(helper, 0o700);
  execFileSync('bash', [OFFSITE_SCRIPT, snapshot], {
    env: {
      ...process.env,
      AMR_EXPORT_PASSPHRASE: 'test-passphrase-at-least-sixteen',
      AMR_OFFSITE_UPLOAD_COMMAND: helper,
      AMR_OFFSITE_BUNDLE_DIR: path.join(f.root, 'bundles'),
      AMR_OFFSITE_TARGET_LABEL: 'test-remote',
      REMOTE_PATH: remote,
    },
    stdio: 'pipe',
  });
  assert.equal(fs.existsSync(remote), true);
  assert.equal(fs.readFileSync(remote).subarray(0, 7).toString(), 'HMAMR1\n');
  assert.equal(verifyOffsiteReceipt(snapshot).ok, true);
});

test('maintenance off-site phase reports only receipts bound to each same-pass snapshot', (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const stamp = '2026-08-17T12-05-00-000Z';
  const backup = snapshotShardsOnce({ dataRoot: f.dataRoot, backupRoot: f.backupRoot, stamp, logger: {} });
  const result = uploadSnapshotsOffsite(backup.snapshots, {
    enabled: true,
    logger: {},
    runner: (_command, args) => {
      const snapshot = args[1];
      const manifestHash = crypto.createHash('sha256')
        .update(fs.readFileSync(path.join(snapshot, 'MANIFEST.json'))).digest('hex');
      fs.writeFileSync(path.join(snapshot, 'OFFSITE_RECEIPT.json'), JSON.stringify({
        complete: true,
        uploaded_at: '2026-08-17T12:06:00Z',
        target: 'test-offsite',
        bundle_sha256: 'b'.repeat(64),
        snapshot_manifest_sha256: manifestHash,
      }));
    },
  });
  assert.deepEqual(result, { attempted: 1, uploaded: 1, failed: 0, orgs: [f.org] });
});

test('maintenance performs upload after snapshot and before destructive eligibility', async (t) => {
  const f = fixture();
  t.after(() => fs.rmSync(f.root, { recursive: true, force: true }));
  const remote = path.join(f.root, 'scheduled-remote.hmamr');
  const helper = path.join(f.root, 'scheduled-upload.sh');
  fs.writeFileSync(helper, `#!/usr/bin/env bash
set -eu
cp "$BACKUP_PATH" "$REMOTE_PATH"
printf '%s  %s\\n' "$BUNDLE_SHA256" "$REMOTE_PATH" | sha256sum -c - >/dev/null
`);
  fs.chmodSync(helper, 0o700);
  const changes = {
    MNEME_DATA_ROOT: f.dataRoot,
    MNEME_BACKUP_ROOT: f.backupRoot,
    MNEME_BACKUP_KEEP: '2',
    MNEME_OFFSITE_UPLOAD_ENABLED: 'true',
    MNEME_MIRROR_BACKFILL_ENABLED: 'false',
    MNEME_COMPACT_ENABLED: 'false',
    AMR_EXPORT_PASSPHRASE: 'scheduled-passphrase-at-least-sixteen',
    AMR_OFFSITE_UPLOAD_COMMAND: helper,
    AMR_OFFSITE_BUNDLE_DIR: path.join(f.root, 'scheduled-bundles'),
    REMOTE_PATH: remote,
  };
  const before = Object.fromEntries(Object.keys(changes).map((key) => [key, process.env[key]]));
  Object.assign(process.env, changes);
  t.after(() => {
    for (const [key, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });

  const result = await runShardMaintenanceOnce({ logger: {} });
  assert.equal(result.backup.snapped, 1);
  assert.deepEqual(result.offsite, { attempted: 1, uploaded: 1, failed: 0, orgs: [f.org] });
  assert.equal(fs.existsSync(remote), true);
  assert.equal(result.compact, null);
});

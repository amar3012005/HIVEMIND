import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { snapshotShardsOnce, verifyShardSnapshot } from '../../src/vector/mneme/shard-maintenance.js';

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

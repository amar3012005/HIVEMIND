import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { snapshotShardsOnce } from '../../src/vector/mneme/shard-maintenance.js';
import {
  activateImportedShard,
  exportAmrBundle,
  importAmrBundle,
} from '../../scripts/amr-portable.mjs';

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-portable-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'mneme');
  const backupRoot = path.join(root, 'backups');
  const org = 'tenant-secret-name';
  const shard = path.join(dataRoot, org);
  fs.mkdirSync(shard, { recursive: true });
  fs.writeFileSync(path.join(shard, 'shard.amr'), 'unique-private-record-content');
  fs.writeFileSync(path.join(shard, 'shard.vec'), 'vector-bytes');
  fs.writeFileSync(path.join(shard, 'shard.txt'), 'text-bytes');
  const result = snapshotShardsOnce({ dataRoot, backupRoot, stamp: '2026-08-17T12-00-00Z', logger: {} });
  assert.equal(result.snapped, 1);
  return { root, dataRoot, org, snapshot: path.join(backupRoot, org, '2026-08-17T12-00-00Z') };
}

class FakeStore {
  constructor({ dataRoot, org }) {
    assert.equal(fs.readFileSync(path.join(dataRoot, org, 'shard.amr'), 'utf8'), 'unique-private-record-content');
  }

  liveCount() { return 4; }
}

test('encrypted AMR export imports only after authentication and isolated open', async (t) => {
  const f = fixture(t);
  const bundle = path.join(f.root, 'portable.amrbundle');
  const passphrase = 'correct horse battery staple';
  const exported = await exportAmrBundle({ snapshotDir: f.snapshot, output: bundle, passphrase });
  assert.match(exported.sha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.readFileSync(bundle).includes(Buffer.from('unique-private-record-content')), false);
  await assert.rejects(
    importAmrBundle({
      bundle,
      destination: path.join(f.root, 'wrong-import'),
      passphrase: 'this passphrase is definitely wrong',
      StoreClass: FakeStore,
    }),
  );

  const destination = path.join(f.root, 'imports', 'verified');
  const imported = await importAmrBundle({ bundle, destination, passphrase, StoreClass: FakeStore });
  assert.deepEqual({ ok: imported.ok, live_count: imported.live_count }, { ok: true, live_count: 4 });
  const receipt = JSON.parse(fs.readFileSync(path.join(destination, 'RESTORE_VERIFIED.json'), 'utf8'));
  assert.equal(receipt.complete, true);
  assert.equal(receipt.bundle_sha256, exported.sha256);
  assert.match(receipt.snapshot_manifest_sha256, /^[a-f0-9]{64}$/);
});

test('activation is atomic, preserves rollback, and refuses an active writer', async (t) => {
  const f = fixture(t);
  const bundle = path.join(f.root, 'portable.amrbundle');
  const passphrase = 'correct horse battery staple';
  await exportAmrBundle({ snapshotDir: f.snapshot, output: bundle, passphrase });
  const imported = path.join(f.dataRoot, '.imports', 'verified');
  await importAmrBundle({ bundle, destination: imported, passphrase, StoreClass: FakeStore });

  assert.throws(
    () => activateImportedShard({ dataRoot: f.dataRoot, org: f.org, importedDir: imported, assertUnlocked: () => { throw new Error('locked'); } }),
    /locked/,
  );
  assert.equal(fs.readFileSync(path.join(f.dataRoot, f.org, 'shard.amr'), 'utf8'), 'unique-private-record-content');

  const activated = activateImportedShard({ dataRoot: f.dataRoot, org: f.org, importedDir: imported, assertUnlocked: () => {} });
  assert.equal(activated.ok, true);
  assert.ok(activated.rollback);
  assert.equal(fs.existsSync(activated.rollback), true);
  assert.equal(fs.readFileSync(path.join(activated.live, 'shard.amr'), 'utf8'), 'unique-private-record-content');
});

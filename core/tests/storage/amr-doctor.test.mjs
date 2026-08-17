import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { snapshotShardsOnce } from '../../src/vector/mneme/shard-maintenance.js';
import { runAmrDoctor } from '../../scripts/amr-doctor.mjs';

test('AMR doctor verifies every live slot without exposing tenant identifiers', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-doctor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'mneme');
  const backupRoot = path.join(root, 'backups');
  const org = 'tenant-sensitive-id';
  const shard = path.join(dataRoot, org);
  fs.mkdirSync(shard, { recursive: true });
  fs.writeFileSync(path.join(shard, 'shard.amr'), 'records');
  fs.writeFileSync(path.join(shard, 'shard.vec'), 'vectors');
  fs.writeFileSync(path.join(shard, 'shard.txt'), 'text');
  fs.writeFileSync(path.join(shard, 'shard.edg'), 'edges');
  snapshotShardsOnce({ dataRoot, backupRoot, logger: {} });

  const result = await runAmrDoctor({ dataRoot, backupRoot, maxAgeHours: 1, dim: 1024, verifyOpen: false });
  assert.equal(result.ok, true);
  assert.equal(result.slot_count, 1);
  assert.equal(result.slots[0].verified, true);
  assert.equal(result.slots[0].opened, true);
  assert.equal(JSON.stringify(result).includes(org), false);
});

test('AMR doctor fails closed when no verified backup exists', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-doctor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'mneme');
  const shard = path.join(dataRoot, 'tenant-a');
  fs.mkdirSync(shard, { recursive: true });
  fs.writeFileSync(path.join(shard, 'shard.amr'), 'records');
  const result = await runAmrDoctor({ dataRoot, backupRoot: path.join(root, 'missing'), maxAgeHours: 1, dim: 1024, verifyOpen: false });
  assert.equal(result.ok, false);
  assert.equal(result.slots[0].error, 'backup_missing');
});

test('AMR doctor copies a verified snapshot and opens only the isolated restore', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-doctor-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'mneme');
  const backupRoot = path.join(root, 'backups');
  const org = 'tenant-open-check';
  const shard = path.join(dataRoot, org);
  fs.mkdirSync(shard, { recursive: true });
  fs.writeFileSync(path.join(shard, 'shard.amr'), 'records');
  fs.writeFileSync(path.join(shard, 'shard.vec'), 'vectors');
  snapshotShardsOnce({ dataRoot, backupRoot, logger: {} });

  let openedPath = null;
  class FakeStore {
    constructor({ dataRoot: isolatedRoot, org: isolatedOrg }) {
      openedPath = path.join(isolatedRoot, isolatedOrg);
      assert.notEqual(openedPath, shard);
      assert.equal(fs.readFileSync(path.join(openedPath, 'shard.amr'), 'utf8'), 'records');
    }

    liveCount() { return 3; }
  }

  const result = await runAmrDoctor({
    dataRoot,
    backupRoot,
    maxAgeHours: 1,
    dim: 1024,
    verifyOpen: true,
    StoreClass: FakeStore,
  });
  assert.equal(result.ok, true);
  assert.equal(result.slots[0].opened, true);
  assert.equal(result.slots[0].live_count, 3);
  assert.equal(fs.existsSync(openedPath), false);
});

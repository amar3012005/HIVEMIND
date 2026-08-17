import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  offsiteEligibleOrgs,
  snapshotShardsOnce,
  verifyShardSnapshot,
} from '../../src/vector/mneme/shard-maintenance.js';

test('native AMR compaction requires the same-pass receipt and preserves recall', async (t) => {
  let AmrMemoryStore;
  try { ({ AmrMemoryStore } = await import('../../src/vector/mneme/amr-store.mjs')); }
  catch (error) { t.skip(`native binding unavailable: ${error.message}`); return; }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-compact-parity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'mneme');
  const backupRoot = path.join(root, 'backups');
  const org = 'native-compact-canary';
  const store = new AmrMemoryStore({ dataRoot, org, dim: 8 });

  for (let i = 0; i < 40; i += 1) {
    const vector = new Float32Array(8);
    vector[i % vector.length] = 1;
    assert.deepEqual(store.write({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      content: `Compaction parity record ${i}`,
      memoryType: 'fact',
      isLatest: true,
      layer: 'memory',
      tags: ['entity:compaction-canary'],
    }, vector), { ok: true });
  }
  for (let i = 0; i < 20; i += 1) {
    assert.equal(store.remove(`00000000-0000-4000-8000-${String(i).padStart(12, '0')}`), true);
  }
  const survivor = '00000000-0000-4000-8000-000000000024';
  for (let i = 0; i < 12; i += 1) {
    store.updateTags(survivor, ['entity:compaction-canary', `revision:${i}`]);
  }

  const query = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
  const before = store.recall(query, 20, {}).map((row) => row.id);
  assert.equal(store.liveCount(), 20);
  assert.ok(before.includes(survivor));

  const stamp = '2026-08-17T13-00-00Z';
  const pass = snapshotShardsOnce({ dataRoot, backupRoot, stamp, logger: {} });
  assert.equal(pass.snapped, 1);
  const snapshot = pass.snapshots[0];
  assert.equal(verifyShardSnapshot(snapshot.path).ok, true);
  assert.deepEqual(offsiteEligibleOrgs(pass.snapshots), []);

  const manifestBytes = fs.readFileSync(path.join(snapshot.path, 'MANIFEST.json'));
  fs.writeFileSync(path.join(snapshot.path, 'OFFSITE_RECEIPT.json'), JSON.stringify({
    version: 1,
    complete: true,
    uploaded_at: '2026-08-17T13:01:00Z',
    target: 'isolated-test-target',
    bundle_sha256: 'c'.repeat(64),
    snapshot_manifest_sha256: crypto.createHash('sha256').update(manifestBytes).digest('hex'),
  }));
  assert.deepEqual(offsiteEligibleOrgs(pass.snapshots), [org]);

  const reclaimed = store.compact();
  assert.ok(Number.isFinite(reclaimed));
  assert.equal(store.liveCount(), 20);
  assert.deepEqual(store.recall(query, 20, {}).map((row) => row.id), before);
  assert.equal(store.recall(query, 20, {}).some((row) => /00000000000[0-9]$/.test(row.id)), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { snapshotShardsOnce } from '../../src/vector/mneme/shard-maintenance.js';
import { exportAmrBundle, importAmrBundle } from '../../scripts/amr-portable.mjs';

test('native AMR portable restore recalls the exact known vector', async (t) => {
  let AmrMemoryStore;
  try { ({ AmrMemoryStore } = await import('../../src/vector/mneme/amr-store.mjs')); }
  catch (error) { t.skip(`native binding unavailable: ${error.message}`); return; }

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-native-portable-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dataRoot = path.join(root, 'mneme');
  const backupRoot = path.join(root, 'backups');
  const org = 'native-portable-canary';
  const id = '00000000-0000-4000-8000-00000000a111';
  const vector = Float32Array.from([1, 0, 0, 0, 0, 0, 0, 0]);
  const store = new AmrMemoryStore({ dataRoot, org, dim: 8 });
  assert.deepEqual(store.write({
    id,
    content: 'The exact portable recovery marker is AMR-RECOVERY-8111.',
    memoryType: 'fact',
    isLatest: true,
    layer: 'memory',
  }, vector), { ok: true });

  const snap = snapshotShardsOnce({ dataRoot, backupRoot, stamp: '2026-08-17T12-30-00Z', logger: {} });
  assert.equal(snap.snapped, 1);
  const bundle = path.join(root, 'canary.amrbundle');
  const passphrase = 'native portable canary passphrase';
  await exportAmrBundle({ snapshotDir: path.join(backupRoot, org, '2026-08-17T12-30-00Z'), output: bundle, passphrase });
  const imported = await importAmrBundle({
    bundle,
    destination: path.join(root, 'imports', 'restored'),
    passphrase,
    dim: 8,
    StoreClass: AmrMemoryStore,
    canary: { id, vector },
  });
  assert.equal(imported.ok, true);
  assert.equal(imported.live_count, 1);
});

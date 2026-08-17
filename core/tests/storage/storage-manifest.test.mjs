import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageManifest, verifyStorageManifest } from '../../../scripts/storage-manifest.mjs';

test('managed backup manifest verifies all artifacts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-storage-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'postgres.dump'), 'pg');
  fs.writeFileSync(path.join(root, 'qdrant.snapshot'), 'qdrant');
  createStorageManifest(root, { storageMode: 'managed', tenant: 'platform', createdAt: '2026-08-17T00:00:00Z' });
  assert.deepEqual(verifyStorageManifest(root), {
    ok: true, storage_mode: 'managed', artifacts: 2, created_at: '2026-08-17T00:00:00Z',
  });
});

test('manifest verifier detects corrupted artifact', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-storage-manifest-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'postgres.dump'), 'pg');
  createStorageManifest(root, { storageMode: 'byod', tenant: 'tenant-hash' });
  fs.writeFileSync(path.join(root, 'postgres.dump'), 'changed');
  assert.match(verifyStorageManifest(root).error, /size_mismatch|checksum_mismatch/);
});


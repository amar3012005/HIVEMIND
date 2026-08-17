import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createStorageManifest } from '../../../scripts/storage-manifest.mjs';
import { decryptStorageBundle, encryptStorageBundle } from '../../../scripts/storage-bundle-crypto.mjs';

test('managed recovery bundle is authenticated, encrypted, and manifest-verified after restore', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-storage-crypto-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source'); fs.mkdirSync(source);
  const unique = 'managed-database-private-content';
  fs.writeFileSync(path.join(source, 'postgres.dump'), unique);
  fs.writeFileSync(path.join(source, 'qdrant.snapshot'), 'vector-data');
  createStorageManifest(source, { storageMode: 'managed' });
  process.env.STORAGE_BACKUP_ENCRYPTION_KEY = crypto.randomBytes(32).toString('base64');
  const bundle = path.join(root, 'backup.hmstorage');
  const encrypted = await encryptStorageBundle({ source, output: bundle });
  assert.equal(encrypted.ok, true);
  assert.equal(fs.readFileSync(bundle).includes(Buffer.from(unique)), false);
  const destination = path.join(root, 'restored');
  const restored = await decryptStorageBundle({ bundle, destination });
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(path.join(destination, 'postgres.dump'), 'utf8'), unique);

  const bytes = fs.readFileSync(bundle); bytes[Math.floor(bytes.length / 2)] ^= 1;
  fs.writeFileSync(bundle, bytes);
  await assert.rejects(decryptStorageBundle({ bundle, destination: path.join(root, 'tampered') }));
});

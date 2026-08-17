#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const MANIFEST = 'STORAGE_MANIFEST.json';

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    do {
      read = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (read) hash.update(buffer.subarray(0, read));
    } while (read);
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function artifactFiles(root) {
  return fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name !== MANIFEST)
    .map((entry) => entry.name)
    .sort();
}

export function createStorageManifest(root, {
  storageMode,
  tenant = 'platform',
  release = process.env.HIVEMIND_RELEASE_SHA || 'unknown',
  consistency = 'warm',
  createdAt = new Date().toISOString(),
  metadata = {},
} = {}) {
  if (!['personal_amr', 'managed', 'byod'].includes(storageMode)) {
    throw new Error('storageMode must be personal_amr, managed, or byod');
  }
  const files = artifactFiles(root);
  if (!files.length) throw new Error('backup contains no artifacts');
  const artifacts = Object.fromEntries(files.map((name) => {
    const stat = fs.statSync(path.join(root, name));
    return [name, { bytes: stat.size, sha256: sha256File(path.join(root, name)) }];
  }));
  const safeMetadata = {};
  for (const [key, value] of Object.entries(metadata || {})) {
    if (/secret|token|password|credential|database.?url|api.?key/i.test(key)) {
      throw new Error(`forbidden manifest metadata key: ${key}`);
    }
    if (!/^[a-z][a-z0-9_]{0,63}$/i.test(key)
        || !['string', 'number', 'boolean'].includes(typeof value)) {
      throw new Error(`invalid manifest metadata: ${key}`);
    }
    safeMetadata[key] = value;
  }
  const manifest = {
    version: 1,
    storage_mode: storageMode,
    tenant,
    created_at: createdAt,
    release,
    consistency,
    metadata: safeMetadata,
    artifacts,
    complete: true,
  };
  const temp = path.join(root, `.${MANIFEST}.${process.pid}.tmp`);
  fs.writeFileSync(temp, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temp, path.join(root, MANIFEST));
  return manifest;
}

export function verifyStorageManifest(root) {
  let manifest;
  try { manifest = JSON.parse(fs.readFileSync(path.join(root, MANIFEST), 'utf8')); }
  catch (error) { return { ok: false, error: `manifest_unreadable:${error.message}` }; }
  if (manifest?.version !== 1 || manifest?.complete !== true || !manifest.artifacts) {
    return { ok: false, error: 'manifest_incomplete' };
  }
  const names = Object.keys(manifest.artifacts);
  if (!names.length) return { ok: false, error: 'manifest_empty' };
  for (const name of names) {
    if (name !== path.basename(name) || name === MANIFEST) return { ok: false, error: `invalid_artifact_name:${name}` };
    const expected = manifest.artifacts[name];
    if (!Number.isSafeInteger(expected?.bytes) || !/^[a-f0-9]{64}$/.test(expected?.sha256 || '')) {
      return { ok: false, error: `invalid_artifact_metadata:${name}` };
    }
    const filePath = path.join(root, name);
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) return { ok: false, error: `artifact_not_regular:${name}` };
      if (stat.size !== expected.bytes) return { ok: false, error: `size_mismatch:${name}` };
      if (sha256File(filePath) !== expected.sha256) return { ok: false, error: `checksum_mismatch:${name}` };
    } catch (error) { return { ok: false, error: `artifact_unreadable:${name}:${error.message}` }; }
  }
  return { ok: true, storage_mode: manifest.storage_mode, artifacts: names.length, created_at: manifest.created_at };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, root, storageMode, tenant] = process.argv.slice(2);
  try {
    let metadata = {};
    if (process.env.STORAGE_MANIFEST_METADATA_JSON) {
      metadata = JSON.parse(process.env.STORAGE_MANIFEST_METADATA_JSON);
    }
    const result = command === 'create'
      ? createStorageManifest(root, { storageMode, tenant, metadata })
      : command === 'verify'
        ? verifyStorageManifest(root)
        : { ok: false, error: 'usage: storage-manifest.mjs create|verify <backup-dir> [storage-mode] [tenant]' };
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

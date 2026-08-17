#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';

import { verifyShardSnapshot } from '../src/vector/mneme/shard-maintenance.js';

const MAGIC = Buffer.from('HMAMR1\n');
const TAG_BYTES = 16;
const ALLOWED = new Set(['shard.amr', 'shard.vec', 'shard.txt', 'shard.edg', 'MANIFEST.json']);

function requirePassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.length < 16) {
    throw new Error('AMR_EXPORT_PASSPHRASE must contain at least 16 characters');
  }
  return passphrase;
}

function keyFor(passphrase, salt) {
  return crypto.scryptSync(requirePassphrase(passphrase), salt, 32, {
    N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024,
  });
}

function sha256File(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buf = Buffer.allocUnsafe(1024 * 1024);
  try {
    let n;
    do {
      n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n) hash.update(buf.subarray(0, n));
    } while (n);
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function headerBytes(header) {
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.allocUnsafe(4);
  length.writeUInt32BE(json.length);
  return { json, prefix: Buffer.concat([MAGIC, length, json]) };
}

async function encryptTar(tarFile, output, passphrase) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const header = {
    version: 1,
    cipher: 'aes-256-gcm',
    kdf: 'scrypt',
    salt: salt.toString('base64'),
    iv: iv.toString('base64'),
    created_at: new Date().toISOString(),
  };
  const { prefix } = headerBytes(header);
  const temp = `${output}.partial-${process.pid}`;
  fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(temp, 'w', 0o600);
  fs.writeSync(fd, prefix);
  fs.closeSync(fd);
  const cipher = crypto.createCipheriv('aes-256-gcm', keyFor(passphrase, salt), iv);
  cipher.setAAD(prefix);
  await pipeline(fs.createReadStream(tarFile), cipher, fs.createWriteStream(temp, { flags: 'a', mode: 0o600 }));
  fs.appendFileSync(temp, cipher.getAuthTag());
  fs.renameSync(temp, output);
  return { output, sha256: sha256File(output), bytes: fs.statSync(output).size };
}

function readHeader(bundle) {
  const fd = fs.openSync(bundle, 'r');
  try {
    const fixed = Buffer.alloc(MAGIC.length + 4);
    fs.readSync(fd, fixed, 0, fixed.length, 0);
    if (!fixed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('invalid AMR bundle magic');
    const length = fixed.readUInt32BE(MAGIC.length);
    if (length < 2 || length > 8192) throw new Error('invalid AMR bundle header length');
    const json = Buffer.alloc(length);
    fs.readSync(fd, json, 0, length, fixed.length);
    const header = JSON.parse(json.toString('utf8'));
    if (header.version !== 1 || header.cipher !== 'aes-256-gcm' || header.kdf !== 'scrypt') {
      throw new Error('unsupported AMR bundle format');
    }
    return { header, prefix: Buffer.concat([fixed, json]), offset: fixed.length + length };
  } finally { fs.closeSync(fd); }
}

async function decryptTar(bundle, output, passphrase) {
  const { header, prefix, offset } = readHeader(bundle);
  const stat = fs.statSync(bundle);
  if (stat.size <= offset + TAG_BYTES) throw new Error('truncated AMR bundle');
  const tag = Buffer.alloc(TAG_BYTES);
  const fd = fs.openSync(bundle, 'r');
  try { fs.readSync(fd, tag, 0, TAG_BYTES, stat.size - TAG_BYTES); } finally { fs.closeSync(fd); }
  const salt = Buffer.from(header.salt, 'base64');
  const iv = Buffer.from(header.iv, 'base64');
  if (salt.length !== 16 || iv.length !== 12) throw new Error('invalid AMR bundle cryptographic header');
  const decipher = crypto.createDecipheriv('aes-256-gcm', keyFor(passphrase, salt), iv);
  decipher.setAAD(prefix);
  decipher.setAuthTag(tag);
  await pipeline(
    fs.createReadStream(bundle, { start: offset, end: stat.size - TAG_BYTES - 1 }),
    decipher,
    fs.createWriteStream(output, { mode: 0o600 }),
  );
}

function archiveNames(tarFile) {
  const names = execFileSync('tar', ['-tf', tarFile], { encoding: 'utf8' })
    .split('\n').map((name) => name.replace(/^\.\//, '')).filter(Boolean);
  if (!names.length || names.some((name) => !ALLOWED.has(name) || path.basename(name) !== name)) {
    throw new Error('AMR bundle contains an unsafe or unexpected archive entry');
  }
  return names;
}

export async function exportAmrBundle({ snapshotDir, output, passphrase }) {
  const verified = verifyShardSnapshot(snapshotDir);
  if (!verified.ok) throw new Error(`snapshot verification failed: ${verified.error}`);
  const manifest = JSON.parse(fs.readFileSync(path.join(snapshotDir, 'MANIFEST.json'), 'utf8'));
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-amr-export-'));
  const tarFile = path.join(temp, 'snapshot.tar');
  try {
    execFileSync('tar', ['-cf', tarFile, '-C', snapshotDir, ...manifest.files, 'MANIFEST.json']);
    return await encryptTar(tarFile, output, passphrase);
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function verifyImportedSnapshot({ snapshotDir, dim = 1024, StoreClass = null, canary = null }) {
  const verified = verifyShardSnapshot(snapshotDir);
  if (!verified.ok) throw new Error(`snapshot verification failed: ${verified.error}`);
  let Store = StoreClass;
  if (!Store) ({ AmrMemoryStore: Store } = await import('../src/vector/mneme/amr-store.mjs'));
  const root = path.dirname(snapshotDir);
  const org = path.basename(snapshotDir);
  const store = new Store({ dataRoot: root, org, dim });
  const liveCount = Number(store.liveCount());
  if (!Number.isSafeInteger(liveCount) || liveCount < 0) throw new Error('restored shard returned an invalid live count');
  let recallCanary = null;
  if (canary) {
    const hits = store.recall(canary.vector, Math.max(1, Number(canary.limit || 5)), canary.filter || {});
    recallCanary = hits.some((hit) => hit.id === canary.id);
    if (!recallCanary) throw new Error('restored shard recall canary failed');
  }
  return { ok: true, live_count: liveCount, empty: liveCount === 0, recall_canary: recallCanary };
}

export async function importAmrBundle({ bundle, destination, passphrase, dim = 1024, StoreClass = null, canary = null }) {
  if (fs.existsSync(destination)) throw new Error('import destination already exists');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const temp = fs.mkdtempSync(path.join(path.dirname(destination), '.amr-import-partial-'));
  const tarFile = path.join(temp, 'snapshot.tar');
  const extracted = path.join(temp, 'restored');
  fs.mkdirSync(extracted, { mode: 0o700 });
  try {
    await decryptTar(bundle, tarFile, passphrase);
    archiveNames(tarFile);
    execFileSync('tar', ['-xf', tarFile, '-C', extracted, '--no-same-owner', '--no-same-permissions']);
    const opened = await verifyImportedSnapshot({ snapshotDir: extracted, dim, StoreClass, canary });
    const receipt = {
      version: 1,
      verified_at: new Date().toISOString(),
      bundle_sha256: sha256File(bundle),
      snapshot_manifest_sha256: sha256File(path.join(extracted, 'MANIFEST.json')),
      live_count: opened.live_count,
      recall_canary: opened.recall_canary,
      complete: true,
    };
    fs.writeFileSync(path.join(extracted, 'RESTORE_VERIFIED.json'), `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(extracted, destination);
    return { ok: true, destination, live_count: opened.live_count, empty: opened.empty };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

function defaultAssertUnlocked(lockFile) {
  if (process.platform !== 'linux') throw new Error('AMR activation requires Linux flock');
  try { execFileSync('flock', ['-n', lockFile, '-c', 'true'], { stdio: 'ignore' }); }
  catch { throw new Error('active AMR shard is locked; stop every writer before activation'); }
}

function fsyncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

export function activateImportedShard({ dataRoot, org, importedDir, assertUnlocked = defaultAssertUnlocked }) {
  const receiptPath = path.join(importedDir, 'RESTORE_VERIFIED.json');
  const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
  if (receipt?.complete !== true || !/^[a-f0-9]{64}$/.test(receipt.bundle_sha256 || '')
      || !/^[a-f0-9]{64}$/.test(receipt.snapshot_manifest_sha256 || '')) {
    throw new Error('import lacks a valid verification receipt');
  }
  if (sha256File(path.join(importedDir, 'MANIFEST.json')) !== receipt.snapshot_manifest_sha256) {
    throw new Error('import manifest changed after verification');
  }
  const verified = verifyShardSnapshot(importedDir);
  if (!verified.ok) throw new Error(`import changed after verification: ${verified.error}`);
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const live = path.join(dataRoot, org);
  if (fs.statSync(importedDir).dev !== fs.statSync(dataRoot).dev) {
    throw new Error('atomic activation requires import and data root on the same filesystem');
  }
  if (fs.existsSync(live)) assertUnlocked(path.join(live, 'shard.lock'));
  const rollback = `${live}.rollback-${new Date().toISOString().replace(/[:.]/g, '-')}`;
  let movedLive = false;
  try {
    if (fs.existsSync(live)) { fs.renameSync(live, rollback); movedLive = true; }
    fs.renameSync(importedDir, live);
    fsyncDirectory(dataRoot);
    return { ok: true, live, rollback: movedLive ? rollback : null };
  } catch (error) {
    if (!fs.existsSync(live) && movedLive && fs.existsSync(rollback)) fs.renameSync(rollback, live);
    throw error;
  }
}

function argsOf(argv) {
  const out = { command: argv[0], dim: Number(process.env.MNEME_DIM || 1024) };
  for (let i = 1; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--snapshot') out.snapshotDir = argv[++i];
    else if (arg === '--output') out.output = argv[++i];
    else if (arg === '--bundle') out.bundle = argv[++i];
    else if (arg === '--destination') out.destination = argv[++i];
    else if (arg === '--data-root') out.dataRoot = argv[++i];
    else if (arg === '--org') out.org = argv[++i];
    else if (arg === '--dim') out.dim = Number(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const args = argsOf(process.argv.slice(2));
    let result;
    if (args.command === 'export') result = await exportAmrBundle({
      snapshotDir: args.snapshotDir, output: args.output, passphrase: process.env.AMR_EXPORT_PASSPHRASE,
    });
    else if (args.command === 'import') result = await importAmrBundle({
      bundle: args.bundle, destination: args.destination,
      passphrase: process.env.AMR_EXPORT_PASSPHRASE, dim: args.dim,
    });
    else if (args.command === 'activate') result = activateImportedShard(args);
    else throw new Error('usage: amr-portable.mjs export|import|activate [options]');
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

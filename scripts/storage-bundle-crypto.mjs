#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { pipeline } from 'node:stream/promises';
import { verifyStorageManifest } from './storage-manifest.mjs';

const MAGIC = Buffer.from('HMSTORAGE1\n');
const TAG_BYTES = 16;

function key() {
  const value = process.env.STORAGE_BACKUP_ENCRYPTION_KEY;
  const decoded = value ? Buffer.from(value, 'base64') : Buffer.alloc(0);
  if (decoded.length !== 32) throw new Error('STORAGE_BACKUP_ENCRYPTION_KEY must be 32 bytes encoded as base64');
  return decoded;
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  const buffer = Buffer.allocUnsafe(1024 * 1024);
  try {
    let read;
    do { read = fs.readSync(fd, buffer, 0, buffer.length, null); if (read) hash.update(buffer.subarray(0, read)); } while (read);
  } finally { fs.closeSync(fd); }
  return hash.digest('hex');
}

function prefix(header) {
  const json = Buffer.from(JSON.stringify(header));
  const length = Buffer.allocUnsafe(4); length.writeUInt32BE(json.length);
  return Buffer.concat([MAGIC, length, json]);
}

function readHeader(bundle) {
  const fixed = Buffer.alloc(MAGIC.length + 4);
  const fd = fs.openSync(bundle, 'r');
  try {
    fs.readSync(fd, fixed, 0, fixed.length, 0);
    if (!fixed.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error('invalid storage bundle magic');
    const length = fixed.readUInt32BE(MAGIC.length);
    if (length < 2 || length > 8192) throw new Error('invalid storage bundle header');
    const json = Buffer.alloc(length); fs.readSync(fd, json, 0, length, fixed.length);
    const header = JSON.parse(json.toString('utf8'));
    if (header?.version !== 1 || header?.cipher !== 'aes-256-gcm') throw new Error('unsupported storage bundle format');
    return { header, prefix: Buffer.concat([fixed, json]), offset: fixed.length + length };
  } finally { fs.closeSync(fd); }
}

export async function encryptStorageBundle({ source, output }) {
  const verified = verifyStorageManifest(source);
  if (!verified.ok) throw new Error(`storage manifest failed: ${verified.error}`);
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-storage-encrypt-'));
  const tar = path.join(temp, 'backup.tar');
  try {
    execFileSync('tar', ['-cf', tar, '-C', source, '.']);
    const salt = crypto.randomBytes(16); const iv = crypto.randomBytes(12);
    const head = prefix({ version: 1, cipher: 'aes-256-gcm', kdf: 'scrypt', salt: salt.toString('base64'), iv: iv.toString('base64') });
    const derived = crypto.scryptSync(key(), salt, 32, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
    const cipher = crypto.createCipheriv('aes-256-gcm', derived, iv); cipher.setAAD(head);
    const partial = `${output}.partial-${process.pid}`;
    fs.mkdirSync(path.dirname(output), { recursive: true, mode: 0o700 });
    fs.writeFileSync(partial, head, { mode: 0o600 });
    await pipeline(fs.createReadStream(tar), cipher, fs.createWriteStream(partial, { flags: 'a', mode: 0o600 }));
    fs.appendFileSync(partial, cipher.getAuthTag()); fs.renameSync(partial, output);
    return { ok: true, sha256: sha256(output), bytes: fs.statSync(output).size };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

export async function decryptStorageBundle({ bundle, destination }) {
  if (fs.existsSync(destination)) throw new Error('restore destination already exists');
  fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  const { header, prefix: head, offset } = readHeader(bundle);
  const stat = fs.statSync(bundle); if (stat.size <= offset + TAG_BYTES) throw new Error('truncated storage bundle');
  const tag = Buffer.alloc(TAG_BYTES); const fd = fs.openSync(bundle, 'r');
  try { fs.readSync(fd, tag, 0, tag.length, stat.size - tag.length); } finally { fs.closeSync(fd); }
  const derived = crypto.scryptSync(key(), Buffer.from(header.salt, 'base64'), 32, { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 });
  const decipher = crypto.createDecipheriv('aes-256-gcm', derived, Buffer.from(header.iv, 'base64'));
  decipher.setAAD(head); decipher.setAuthTag(tag);
  const temp = fs.mkdtempSync(path.join(path.dirname(destination), '.storage-restore-partial-'));
  const tar = path.join(temp, 'backup.tar'); const extracted = path.join(temp, 'restored');
  fs.mkdirSync(extracted, { mode: 0o700 });
  try {
    await pipeline(fs.createReadStream(bundle, { start: offset, end: stat.size - TAG_BYTES - 1 }), decipher, fs.createWriteStream(tar, { mode: 0o600 }));
    const names = execFileSync('tar', ['-tf', tar], { encoding: 'utf8' }).split('\n')
      .map((name) => name.replace(/^\.\//, '')).filter((name) => name && name !== '.');
    if (!names.length || names.some((name) => path.isAbsolute(name) || name.split('/').includes('..'))) throw new Error('unsafe storage bundle archive');
    const manifestText = execFileSync('tar', ['-xOf', tar, './STORAGE_MANIFEST.json'], { encoding: 'utf8' });
    const manifest = JSON.parse(manifestText);
    const allowed = new Set(['STORAGE_MANIFEST.json', ...Object.keys(manifest.artifacts || {})]);
    if (new Set(names).size !== names.length || names.some((name) => !allowed.has(name))
        || [...allowed].some((name) => !names.includes(name))) {
      throw new Error('storage bundle entries do not match the signed manifest boundary');
    }
    execFileSync('tar', ['-xf', tar, '-C', extracted, '--no-same-owner', '--no-same-permissions']);
    const verified = verifyStorageManifest(extracted);
    if (!verified.ok) throw new Error(`restored storage manifest failed: ${verified.error}`);
    fs.renameSync(extracted, destination);
    return { ok: true, ...verified };
  } finally { fs.rmSync(temp, { recursive: true, force: true }); }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  try {
    const [command, source, target] = process.argv.slice(2);
    const result = command === 'encrypt'
      ? await encryptStorageBundle({ source, output: target })
      : command === 'decrypt'
        ? await decryptStorageBundle({ bundle: source, destination: target })
        : (() => { throw new Error('usage: storage-bundle-crypto.mjs encrypt|decrypt SOURCE TARGET'); })();
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) { process.stderr.write(`${error.message}\n`); process.exitCode = 1; }
}

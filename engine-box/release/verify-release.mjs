#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [directory] = process.argv.slice(2);
if (!directory) throw new Error('usage: node verify-release.mjs signed-dir');
const raw = fs.readFileSync(path.join(directory, 'release.json'));
const signature = fs.readFileSync(path.join(directory, 'release.sig'));
const publicKey = fs.readFileSync(path.join(directory, 'release.pub'));
if (!crypto.verify(null, raw, publicKey, signature)) throw new Error('release signature verification failed');
const manifest = JSON.parse(raw);
if (typeof manifest.host_requirements?.docker_version !== 'string' || !manifest.host_requirements.docker_version.trim() || /[\r\n]/.test(manifest.host_requirements.docker_version)) {
  throw new Error('manifest lacks a valid pinned Docker version');
}
for (const image of manifest.images || []) {
  if (!/^sha256:[a-f0-9]{64}$/i.test(image.digest) || !String(image.image || '').endsWith(`@${image.digest}`)) throw new Error(`invalid image pin: ${image.name || 'unknown'}`);
}
console.log(JSON.stringify({ ok: true, release: manifest.release, image_count: manifest.images.length, manifest_sha256: crypto.createHash('sha256').update(raw).digest('hex') }));

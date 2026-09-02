#!/usr/bin/env node
// Offline-only: signs an already-built manifest. It never builds images, talks
// to a registry, or receives customer content.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const [manifestPath, outputDirectory] = process.argv.slice(2);
const privateKeyPath = process.env.ENGINE_BOX_RELEASE_PRIVATE_KEY;
if (!manifestPath || !outputDirectory || !privateKeyPath) throw new Error('usage: ENGINE_BOX_RELEASE_PRIVATE_KEY=/offline/key node sign-release.mjs release.json signed-dir');
const raw = fs.readFileSync(manifestPath);
const manifest = JSON.parse(raw);
if (!manifest.release || !Array.isArray(manifest.images) || manifest.images.length < 10) throw new Error('manifest lacks a complete Engine Box image set');
if (typeof manifest.host_requirements?.docker_version !== 'string' || !manifest.host_requirements.docker_version.trim() || /[\r\n]/.test(manifest.host_requirements.docker_version)) {
  throw new Error('manifest lacks a valid pinned Docker version');
}
for (const image of manifest.images) {
  if (!image.name || !/^sha256:[a-f0-9]{64}$/i.test(image.digest) || !String(image.image || '').endsWith(`@${image.digest}`)) {
    throw new Error(`untrusted image entry: ${image.name || 'unknown'}`);
  }
}
fs.mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
const privateKey = fs.readFileSync(privateKeyPath);
const signature = crypto.sign(null, raw, privateKey);
const publicKey = crypto.createPublicKey(privateKey).export({ type: 'spki', format: 'pem' });
fs.copyFileSync(manifestPath, path.join(outputDirectory, 'release.json'));
fs.writeFileSync(path.join(outputDirectory, 'release.sig'), signature, { mode: 0o600 });
fs.writeFileSync(path.join(outputDirectory, 'release.pub'), publicKey, { mode: 0o644 });
console.log(JSON.stringify({ ok: true, release: manifest.release, manifest_sha256: crypto.createHash('sha256').update(raw).digest('hex') }));

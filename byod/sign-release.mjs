#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { publicKeyFingerprint, signReleaseManifest } from './release-contract.mjs';

const DEFAULT_CAPABILITIES = [
  'evidence.hydrate', 'evidence.lexical', 'evidence.recall', 'graph.read',
  'memory.hydrate', 'memory.lexical', 'memory.list.total', 'memory.recall',
  'relationship.read', 'vector.pending', 'vector.repair', 'vector.status',
];

try {
  const [image, release, bundleUrl, bundleSha256, outputDir] = process.argv.slice(2);
  const privateKeyPath = process.env.BYOD_RELEASE_PRIVATE_KEY;
  const sourceSha = process.env.BYOD_RELEASE_SOURCE_SHA;
  const channel = process.env.BYOD_RELEASE_CHANNEL || 'canary';
  const keyId = process.env.BYOD_RELEASE_KEY_ID;
  if (!image || !release || !bundleUrl || !bundleSha256 || !outputDir || !privateKeyPath || !sourceSha || !keyId) {
    throw new Error('usage: BYOD_RELEASE_PRIVATE_KEY=... BYOD_RELEASE_SOURCE_SHA=... BYOD_RELEASE_KEY_ID=... sign-release.mjs IMAGE@sha256:DIGEST RELEASE BUNDLE_URL BUNDLE_SHA256 OUTPUT_DIR');
  }
  const privateKey = fs.readFileSync(privateKeyPath);
  const capabilities = process.env.BYOD_RELEASE_REQUIRED_CAPABILITIES
    ? JSON.parse(process.env.BYOD_RELEASE_REQUIRED_CAPABILITIES)
    : DEFAULT_CAPABILITIES;
  const manifest = {
    version: 2,
    release,
    channel,
    source_sha: sourceSha,
    created_at: new Date().toISOString(),
    protocol_version: process.env.BYOD_RELEASE_PROTOCOL_VERSION || 'memory-box.v1',
    schema_version: Number(process.env.BYOD_RELEASE_SCHEMA_VERSION || 2),
    image,
    required_capabilities: [...capabilities].sort(),
    bundle_url: bundleUrl,
    bundle_sha256: bundleSha256,
    key_id: keyId,
    public_key_sha256: publicKeyFingerprint(privateKey),
  };
  if (process.env.BYOD_RELEASE_VALID_FROM) manifest.valid_from = process.env.BYOD_RELEASE_VALID_FROM;
  if (process.env.BYOD_RELEASE_EXPIRES_AT) manifest.expires_at = process.env.BYOD_RELEASE_EXPIRES_AT;
  const { bytes, signature } = signReleaseManifest(manifest, privateKey);
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outputDir, 'release.json'), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(outputDir, 'release.sig'), signature, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, version: 2, release, channel, image })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

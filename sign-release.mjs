#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { signReleaseManifest } from './release-contract.mjs';

try {
  const [image, release, outputDir] = process.argv.slice(2);
  const privateKeyPath = process.env.BYOD_RELEASE_PRIVATE_KEY;
  if (!image || !release || !outputDir || !privateKeyPath) {
    throw new Error('usage: BYOD_RELEASE_PRIVATE_KEY=... sign-release.mjs IMAGE@sha256:DIGEST RELEASE OUTPUT_DIR');
  }
  const manifest = {
    version: 1,
    release,
    protocol_version: 'memory-box.v1',
    image,
    created_at: new Date().toISOString(),
  };
  const { bytes, signature } = signReleaseManifest(manifest, fs.readFileSync(privateKeyPath));
  fs.mkdirSync(outputDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(outputDir, 'release.json'), bytes, { mode: 0o600 });
  fs.writeFileSync(path.join(outputDir, 'release.sig'), signature, { mode: 0o600 });
  process.stdout.write(`${JSON.stringify({ ok: true, release, image })}\n`);
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

test('offline release signer produces a verifier-compatible immutable manifest', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'engine-box-release-test-'));
  try {
    const privateKey = crypto.generateKeyPairSync('ed25519').privateKey.export({ type: 'pkcs8', format: 'pem' });
    const keyPath = path.join(root, 'release.key'); const manifestPath = path.join(root, 'manifest.json'); const signed = path.join(root, 'signed');
    fs.writeFileSync(keyPath, privateKey, { mode: 0o600 });
    const digest = `sha256:${'a'.repeat(64)}`;
    fs.writeFileSync(manifestPath, `${JSON.stringify({ release: 'engine-box-test', images: Array.from({ length: 10 }, (_, index) => ({ name: `image-${index}`, digest, image: `registry.example/image-${index}@${digest}` })) })}\n`);
    execFileSync(process.execPath, ['engine-box/release/sign-release.mjs', manifestPath, signed], { cwd: process.cwd(), env: { ...process.env, ENGINE_BOX_RELEASE_PRIVATE_KEY: keyPath } });
    const output = execFileSync(process.execPath, ['engine-box/release/verify-release.mjs', signed], { cwd: process.cwd(), encoding: 'utf8' });
    assert.equal(JSON.parse(output).ok, true);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

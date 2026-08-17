import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { signReleaseManifest, verifyReleaseManifest } from '../../../byod/release-contract.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const UPGRADE = path.resolve(TEST_DIR, '../../../byod/upgrade.sh');
const ROLLBACK = path.resolve(TEST_DIR, '../../../byod/rollback.sh');
const RELEASE_DRILL = path.resolve(TEST_DIR, '../../../byod/signed-release-restore-drill.sh');

test('BYOD release accepts only a valid signature over an immutable digest image', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-byod-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = {
    version: 1,
    release: 'agent-abcdef123456',
    protocol_version: 'memory-box.v1',
    image: `ghcr.io/singulance/hm-agent@sha256:${'a'.repeat(64)}`,
    created_at: '2026-08-17T12:00:00Z',
  };
  const signed = signReleaseManifest(manifest, privateKey);
  const manifestPath = path.join(root, 'release.json');
  const signaturePath = path.join(root, 'release.sig');
  const publicKeyPath = path.join(root, 'release.pub');
  fs.writeFileSync(manifestPath, signed.bytes);
  fs.writeFileSync(signaturePath, signed.signature);
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  assert.deepEqual(verifyReleaseManifest({ manifestPath, signaturePath, publicKeyPath }), manifest);

  const dryRun = execFileSync('bash', [UPGRADE, manifestPath, signaturePath], {
    env: { ...process.env, BYOD_RELEASE_PUBLIC_KEY: publicKeyPath, BYOD_UPGRADE_DRY_RUN: 'true' },
    encoding: 'utf8',
  });
  assert.match(dryRun, /Signed Memory Box release verified/);

  fs.appendFileSync(manifestPath, ' ');
  assert.throws(() => verifyReleaseManifest({ manifestPath, signaturePath, publicKeyPath }), /signature/);
});

test('BYOD release rejects mutable image tags even when signed', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => signReleaseManifest({
    version: 1,
    release: 'agent-abcdef123456',
    protocol_version: 'memory-box.v1',
    image: 'hivemind/hm-agent:latest',
    created_at: '2026-08-17T12:00:00Z',
  }, privateKey), /sha256 digest/);
});

test('BYOD release accepts digest-pinned images from a private registry port', () => {
  const { privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = signReleaseManifest({
    version: 1,
    release: 'agent-private123',
    protocol_version: 'memory-box.v1',
    image: `registry.customer.example:5000/singulance/hm-agent@sha256:${'b'.repeat(64)}`,
    created_at: '2026-08-17T12:00:00Z',
  }, privateKey);
  assert.ok(manifest.signature.length > 0);
});

test('BYOD upgrade and rollback can target an isolated disposable box', () => {
  for (const script of [UPGRADE, ROLLBACK]) {
    const source = fs.readFileSync(script, 'utf8');
    assert.match(source, /BYOD_COMPOSE_FILE/);
    assert.match(source, /BYOD_COMPOSE_PROJECT_NAME/);
    assert.match(source, /BYOD_AGENT_CONTAINER/);
    assert.match(source, /BYOD_RELEASE_STATE_DIR/);
    assert.doesNotMatch(source, /docker (?:inspect|exec) hm-byod-agent/);
  }
});

test('signed release restore drill is isolated and proves recall parity', () => {
  const source = fs.readFileSync(RELEASE_DRILL, 'utf8');
  assert.match(source, /mktemp -d/);
  assert.match(source, /docker network create/);
  assert.match(source, /upgrade\.sh/);
  assert.match(source, /rollback\.sh/);
  assert.match(source, /BASE_HITS.*UPGRADE_HITS/);
  assert.match(source, /BASE_HITS.*ROLLBACK_HITS/);
  assert.match(source, /backup_manifest_sha256/);
  assert.match(source, /release_manifest_sha256/);
  assert.match(source, /upgraded agent is not the signed image/);
  assert.match(source, /rollback did not restore the original image/);
});

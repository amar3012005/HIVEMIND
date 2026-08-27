import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  canonicalizeReleaseManifest,
  publicKeyFingerprint,
  signReleaseManifest,
  validateReleaseManifest,
  verifyReleaseManifest,
} from '../../../byod/release-contract.mjs';

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));
const UPGRADE = path.resolve(TEST_DIR, '../../../byod/upgrade.sh');
const ROLLBACK = path.resolve(TEST_DIR, '../../../byod/rollback.sh');
const RELEASE_DRILL = path.resolve(TEST_DIR, '../../../byod/signed-release-restore-drill.sh');
const SIGN_RELEASE = path.resolve(TEST_DIR, '../../../byod/sign-release.mjs');
const CONTROL_PLANE = path.resolve(TEST_DIR, '../../src/control-plane-server.js');
const BROKER = path.resolve(TEST_DIR, '../../../byod/broker/server.mjs');

function releaseV2(key, overrides = {}) {
  return {
    version: 2,
    release: 'agent-abcdef123456',
    channel: 'canary',
    source_sha: '1'.repeat(40),
    created_at: '2026-08-17T12:00:00.000Z',
    protocol_version: 'memory-box.v1',
    schema_version: 2,
    image: `ghcr.io/singulance/hm-agent@sha256:${'a'.repeat(64)}`,
    required_capabilities: ['evidence.recall', 'memory.recall', 'vector.repair'],
    bundle_url: 'https://get.singulancelabs.com/memory-box/releases/agent-abcdef123456.tar.gz',
    bundle_sha256: 'b'.repeat(64),
    key_id: 'offline-release-2026-01',
    public_key_sha256: publicKeyFingerprint(key),
    ...overrides,
  };
}

function writeSignedRelease(root, manifest, privateKey, options = {}) {
  const signed = signReleaseManifest(manifest, privateKey, options);
  const manifestPath = path.join(root, 'release.json');
  const signaturePath = path.join(root, 'release.sig');
  fs.writeFileSync(manifestPath, signed.bytes);
  fs.writeFileSync(signaturePath, signed.signature);
  return { ...signed, manifestPath, signaturePath };
}

test('BYOD v2 release signs exact canonical bytes and verifies immutable artifacts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-byod-release-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = releaseV2(publicKey);
  const signed = writeSignedRelease(root, manifest, privateKey);
  const { manifestPath, signaturePath } = signed;
  const publicKeyPath = path.join(root, 'release.pub');
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  assert.deepEqual(signed.bytes, canonicalizeReleaseManifest(manifest));
  assert.deepEqual(verifyReleaseManifest({
    manifestPath,
    signaturePath,
    publicKeyPath,
    allowedChannel: 'canary',
    requiredCapabilities: ['memory.recall', 'vector.repair'],
    now: '2026-08-18T00:00:00.000Z',
  }), manifest);

  fs.appendFileSync(manifestPath, ' ');
  assert.throws(() => verifyReleaseManifest({ manifestPath, signaturePath, publicKeyPath }), /signature/);
});

test('BYOD v2 release rejects malformed fields, mutable references, and wrong hashes', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const valid = releaseV2(publicKey);
  const invalid = [
    [{ ...valid, image: 'hivemind/hm-agent:latest' }, /sha256 digest/],
    [{ ...valid, source_sha: 'not-a-sha' }, /source SHA/],
    [{ ...valid, bundle_sha256: 'f'.repeat(63) }, /bundle sha256/],
    [{ ...valid, bundle_url: 'http://get.singulancelabs.com/release.tgz' }, /credential-free HTTPS/],
    [{ ...valid, required_capabilities: ['memory.recall', 'memory.recall'] }, /sorted and unique/],
    [{ ...valid, unexpected: true }, /unknown.*field/],
    [{ ...valid, schema_version: '2' }, /schema version/],
  ];
  for (const [manifest, expected] of invalid) {
    assert.throws(() => signReleaseManifest(manifest, privateKey), expected);
  }
});

test('BYOD v2 release accepts a digest-pinned image from a private registry port', () => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = signReleaseManifest(releaseV2(publicKey, {
    release: 'agent-private123',
    image: `registry.customer.example:5000/singulance/hm-agent@sha256:${'b'.repeat(64)}`,
  }), privateKey);
  assert.ok(manifest.signature.length > 0);
});

test('BYOD v2 enforces channel, validity, expiry, and anti-downgrade policy', () => {
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  const current = releaseV2(publicKey, {
    release: 'agent-current123',
    channel: 'stable',
    created_at: '2026-08-18T12:00:00.000Z',
  });
  const candidate = releaseV2(publicKey, {
    release: 'agent-candidate1',
    channel: 'canary',
    valid_from: '2026-08-17T13:00:00.000Z',
    expires_at: '2026-08-20T00:00:00.000Z',
  });
  assert.throws(() => validateReleaseManifest(candidate, {
    allowedChannel: 'stable', now: '2026-08-18T00:00:00.000Z',
  }), /channel mismatch/);
  assert.throws(() => validateReleaseManifest(candidate, {
    now: '2026-08-17T12:30:00.000Z',
  }), /not yet valid/);
  assert.throws(() => validateReleaseManifest(candidate, {
    now: '2026-08-20T00:00:00.000Z',
  }), /expired/);
  assert.throws(() => validateReleaseManifest(candidate, {
    currentManifest: current, now: '2026-08-18T00:00:00.000Z',
  }), /downgrade/);
});

test('BYOD v2 binds the declared fingerprint to the actual Ed25519 signing key', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-byod-key-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const signer = crypto.generateKeyPairSync('ed25519');
  const replacement = crypto.generateKeyPairSync('ed25519');
  assert.throws(() => signReleaseManifest(
    releaseV2(replacement.publicKey),
    signer.privateKey,
  ), /fingerprint does not match/);

  const manifest = releaseV2(signer.publicKey);
  const bytes = canonicalizeReleaseManifest(manifest);
  const manifestPath = path.join(root, 'release.json');
  const signaturePath = path.join(root, 'release.sig');
  fs.writeFileSync(manifestPath, bytes);
  fs.writeFileSync(signaturePath, crypto.sign(null, bytes, replacement.privateKey));
  const publicKeyPath = path.join(root, 'release.pub');
  fs.writeFileSync(publicKeyPath, replacement.publicKey.export({ type: 'spki', format: 'pem' }));
  assert.throws(() => verifyReleaseManifest({
    manifestPath,
    signaturePath,
    publicKeyPath,
    now: '2026-08-18T00:00:00.000Z',
  }), /fingerprint mismatch/);
});

test('BYOD v2 rejects non-canonical JSON even when signed', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-byod-canonical-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = releaseV2(publicKey);
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  const manifestPath = path.join(root, 'release.json');
  const signaturePath = path.join(root, 'release.sig');
  const publicKeyPath = path.join(root, 'release.pub');
  fs.writeFileSync(manifestPath, bytes);
  fs.writeFileSync(signaturePath, crypto.sign(null, bytes, privateKey));
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  assert.throws(() => verifyReleaseManifest({
    manifestPath, signaturePath, publicKeyPath, now: '2026-08-18T00:00:00.000Z',
  }), /not canonical/);
});

test('legacy v1 verification remains bounded and can be disabled', () => {
  const legacy = {
    version: 1,
    release: 'agent-legacy123',
    protocol_version: 'memory-box.v1',
    image: `ghcr.io/singulance/hm-agent@sha256:${'c'.repeat(64)}`,
    created_at: '2026-08-17T12:00:00Z',
  };
  assert.equal(validateReleaseManifest(legacy), legacy);
  assert.throws(() => validateReleaseManifest(legacy, { allowLegacyV1: false }), /unsupported/);
});

test('offline release CLI publishes only manifest v2 with signing-key identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-byod-sign-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outputDir = path.join(root, 'output');
  const privateKeyPath = path.join(root, 'release.key');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(privateKeyPath, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
  const image = `ghcr.io/singulance/hm-agent@sha256:${'d'.repeat(64)}`;
  const result = JSON.parse(execFileSync(process.execPath, [
    SIGN_RELEASE,
    image,
    'agent-cli123456',
    'https://get.singulancelabs.com/memory-box/releases/agent-cli123456.tar.gz',
    'e'.repeat(64),
    outputDir,
  ], {
    env: {
      ...process.env,
      BYOD_RELEASE_PRIVATE_KEY: privateKeyPath,
      BYOD_RELEASE_SOURCE_SHA: 'f'.repeat(40),
      BYOD_RELEASE_KEY_ID: 'offline-test-key',
      BYOD_RELEASE_CHANNEL: 'stable',
    },
    encoding: 'utf8',
  }));
  assert.equal(result.version, 2);
  const manifest = JSON.parse(fs.readFileSync(path.join(outputDir, 'release.json'), 'utf8'));
  assert.equal(manifest.version, 2);
  assert.deepEqual(manifest.required_capabilities, [
    'document.ingest-mode', 'evidence.hydrate', 'evidence.inventory', 'evidence.lexical',
    'evidence.recall', 'graph.read', 'memory.hydrate', 'memory.inventory',
    'memory.inventory.total', 'memory.lexical', 'memory.recall', 'provenance.read',
    'relationship.read', 'vector.pending', 'vector.repair', 'vector.status',
  ]);
  assert.equal(manifest.channel, 'stable');
  assert.equal(manifest.image, image);
  assert.equal(manifest.public_key_sha256, publicKeyFingerprint(publicKey));
  assert.deepEqual(manifest.required_capabilities, [...manifest.required_capabilities].sort());
});

test('BYOD upgrade and rollback can target an isolated disposable box', () => {
  for (const script of [UPGRADE, ROLLBACK]) {
    const source = fs.readFileSync(script, 'utf8');
    assert.match(source, /memory-box-common\.sh/);
    assert.match(source, /BYOD_AGENT_CONTAINER/);
    assert.match(source, /BYOD_RELEASE_STATE_DIR/);
    assert.doesNotMatch(source, /docker (?:inspect|exec) hm-byod-agent/);
  }
  const upgrade = fs.readFileSync(UPGRADE, 'utf8');
  assert.match(upgrade, /CURRENT_RECEIPT="\$STATE\/CURRENT_RELEASE\.json"/);
  assert.match(upgrade, /PREVIOUS_RECEIPT="\$STATE\/PREVIOUS_RELEASE\.json"/);
  assert.doesNotMatch(upgrade, /hm_atomic_write "\$HM_CURRENT_RECEIPT"/);
  const rollback = fs.readFileSync(ROLLBACK, 'utf8');
  assert.match(rollback, /PREVIOUS_RECEIPT="\$STATE_DIR\/PREVIOUS_RELEASE\.json"/);
  assert.doesNotMatch(rollback, /\$HM_PREVIOUS_RECEIPT/);
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
  assert.match(source, /source_sha:process\.env\.SOURCE_SHA/);
  assert.match(source, /upgraded agent is not the signed image/);
  assert.match(source, /rollback did not restore the original image/);
  assert.match(source, /HIVEMIND_MEMORY_BOX_STATE_DIR="\$STATE"/);
  assert.match(source, /HIVEMIND_MEMORY_BOX_CONFIG_DIR="\$CONFIG"/);
  assert.match(source, /BYOD_SKIP_HOST_PROMOTION=true/);
  assert.match(source, /"release":"restore-base"/);
  assert.match(source, /ready=0/);
  assert.match(source, /"\$ready" -ge 3/);
});

test('central registration delegates to a broker that rejects weak tokens and unsafe endpoints', () => {
  const facade = fs.readFileSync(CONTROL_PLANE, 'utf8');
  const broker = fs.readFileSync(BROKER, 'utf8');
  assert.match(facade, /memoryBoxBrokerRequest\(pathname, body\)/);
  assert.match(broker, /\^\[A-Za-z0-9_\-\]\{43,128\}\$/);
  assert.match(broker, /validateEndpoint\(endpoint, transport/);
  assert.match(broker, /a strong URL-safe agentToken is required/);
});

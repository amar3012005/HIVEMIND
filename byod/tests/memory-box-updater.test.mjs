import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { publicKeyFingerprint, signReleaseManifest } from '../release-contract.mjs';

const BYOD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UPGRADE = path.join(BYOD, 'upgrade.sh');
const CLI = path.join(BYOD, 'hivemind-memory-box');

function fixture(t, overrides = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-updater-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bin = path.join(root, 'bin'); fs.mkdirSync(bin);
  const bundle = path.join(root, 'bundle.tar.gz'); fs.writeFileSync(bundle, 'signed bundle fixture');
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const manifest = {
    version: 2, release: 'agent-abcdef123456', channel: 'stable', source_sha: 'a'.repeat(40),
    created_at: '2026-08-25T12:00:00.000Z', valid_from: '2026-08-25T12:00:00.000Z',
    expires_at: '2099-08-25T12:00:00.000Z', protocol_version: 'memory-box.v1', schema_version: 2,
    image: `ghcr.io/singulance/hm-agent@sha256:${'b'.repeat(64)}`,
    required_capabilities: ['evidence.recall', 'memory.recall'],
    bundle_url: 'https://get.singulancelabs.com/memory-box/releases/agent-abcdef123456.tar.gz',
    bundle_sha256: crypto.createHash('sha256').update(fs.readFileSync(bundle)).digest('hex'),
    key_id: 'release-test-1', public_key_sha256: publicKeyFingerprint(publicKey), ...overrides,
  };
  const signed = signReleaseManifest(manifest, privateKey);
  const manifestPath = path.join(root, 'release.json'), signaturePath = path.join(root, 'release.sig'), publicKeyPath = path.join(root, 'release.pub');
  fs.writeFileSync(manifestPath, signed.bytes); fs.writeFileSync(signaturePath, signed.signature);
  fs.writeFileSync(publicKeyPath, publicKey.export({ type: 'spki', format: 'pem' }));
  const curl = path.join(bin, 'curl');
  fs.writeFileSync(curl, '#!/usr/bin/env bash\nset -eu\nout=""\nwhile (($#)); do if [[ "$1" == -o ]]; then out="$2"; shift 2; else shift; fi; done\ncp "$MOCK_BUNDLE" "$out"\n');
  fs.chmodSync(curl, 0o755);
  const state = path.join(root, 'state'), config = path.join(root, 'config'); fs.mkdirSync(state); fs.mkdirSync(config);
  fs.writeFileSync(path.join(root, 'compose.yml'), 'services:\n  agent: {}\n');
  return { root, manifest, manifestPath, signaturePath, publicKeyPath, bundle, state, config, env: {
    ...process.env, PATH: `${bin}:${process.env.PATH}`, MOCK_BUNDLE: bundle,
    BYOD_RELEASE_PUBLIC_KEY: publicKeyPath, BYOD_RELEASE_STATE_DIR: state,
    HIVEMIND_MEMORY_BOX_STATE_DIR: state, HIVEMIND_MEMORY_BOX_CONFIG_DIR: config,
    HIVEMIND_MEMORY_BOX_LOCK_FILE: path.join(root, 'updater.lock'), BYOD_UPGRADE_DRY_RUN: 'true',
    BYOD_COMPOSE_FILE: path.join(root, 'compose.yml'), BYOD_VERIFY_ATTEMPTS: '1', BYOD_VERIFY_INTERVAL_SECONDS: '0',
    BYOD_REQUIRE_MANIFEST_V2: 'true', BYOD_EXPECTED_CHANNEL: 'stable',
  } };
}

function installDockerMock(f) {
  const docker = path.join(f.root, 'bin', 'docker');
  fs.writeFileSync(docker, `#!/usr/bin/env bash
set -eu
echo "$*" >> "$MOCK_DOCKER_LOG"
if [[ "$1" == inspect ]]; then
  case "$*" in *'.Image}}'*) echo old-image-id;; *'.Config.Image}}'*) echo ghcr.io/singulance/hm-agent@sha256:${'c'.repeat(64)};; *'.Config.Env'*) echo AGENT_RELEASE=agent-old123456;; esac
elif [[ "$1" == exec ]]; then
  release="$(cat "$MOCK_AGENT_STATE")"
  if [[ "\${MOCK_FAIL_NEW:-false}" == true && "$release" == agent-abcdef123456 ]]; then exit 1; fi
  printf '{"health":{"ok":true},"capabilities":{"agent_release":"%s","protocol_version":"memory-box.v1","schema_version":2,"capabilities":["evidence.recall","memory.recall"]},"inventory":{"memories":0,"evidence":0,"documents":0},"recall":{"results":[]}}' "$release"
elif [[ "$1" == compose ]]; then
  override=""
  for arg in "$@"; do [[ "$arg" == *.yml ]] && override="$arg"; done
  sed -n 's/^[[:space:]]*AGENT_RELEASE:[[:space:]]*//p' "$override" | tail -1 > "$MOCK_AGENT_STATE"
fi
`);
  fs.chmodSync(docker, 0o755);
  fs.writeFileSync(path.join(f.root, 'agent-state'), 'agent-old123456'); fs.writeFileSync(path.join(f.root, 'docker.log'), '');
  return { ...f.env, BYOD_UPGRADE_DRY_RUN: 'false', MOCK_AGENT_STATE: path.join(f.root, 'agent-state'), MOCK_DOCKER_LOG: path.join(f.root, 'docker.log') };
}

test('governed dry run verifies canonical v2 signature, channel, and bundle digest', (t) => {
  const f = fixture(t);
  const output = execFileSync('bash', [UPGRADE, f.manifestPath, f.signaturePath], { env: f.env, encoding: 'utf8' });
  assert.match(output, /Signed Memory Box release verified: agent-abcdef123456/);
  assert.equal(fs.readFileSync(path.join(f.state, 'downloads', 'agent-abcdef123456.tar.gz'), 'utf8'), 'signed bundle fixture');
});

test('governed update rejects a channel mismatch', (t) => {
  const f = fixture(t);
  const run = spawnSync('bash', [UPGRADE, f.manifestPath, f.signaturePath], { env: { ...f.env, BYOD_EXPECTED_CHANNEL: 'canary' }, encoding: 'utf8' });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /channel mismatch/);
});

test('governed update rejects downgrade before pulling a bundle', (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.state, 'CURRENT_RELEASE.json'), JSON.stringify({ release: 'agent-newer123', image: 'different', created_at: '2027-08-25T12:00:00.000Z' }));
  const run = spawnSync('bash', [UPGRADE, f.manifestPath, f.signaturePath], { env: f.env, encoding: 'utf8' });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /downgrade rejected/);
  assert.equal(fs.existsSync(path.join(f.state, 'downloads', 'agent-abcdef123456.tar.gz')), false);
});

test('governed update rejects an altered bundle', (t) => {
  const f = fixture(t); fs.writeFileSync(f.bundle, 'altered after signing');
  const run = spawnSync('bash', [UPGRADE, f.manifestPath, f.signaturePath], { env: f.env, encoding: 'utf8' });
  assert.notEqual(run.status, 0); assert.match(run.stderr, /bundle digest mismatch/);
});

test('successful update swaps only agent and commits an atomic verified receipt', (t) => {
  const f = fixture(t), env = installDockerMock(f);
  execFileSync('bash', [UPGRADE, f.manifestPath, f.signaturePath], { env, encoding: 'utf8' });
  const receipt = JSON.parse(fs.readFileSync(path.join(f.state, 'CURRENT_RELEASE.json')));
  assert.equal(receipt.complete, true); assert.equal(receipt.release, f.manifest.release); assert.equal(receipt.rollback_image.startsWith('hivemind/hm-agent:rollback-'), true);
  const log = fs.readFileSync(env.MOCK_DOCKER_LOG, 'utf8');
  assert.match(log, /compose .*up -d --no-deps --force-recreate agent/); assert.doesNotMatch(log, /\bdown\b/);
});

test('failed verification automatically restores the previous local image', (t) => {
  const f = fixture(t), env = { ...installDockerMock(f), MOCK_FAIL_NEW: 'true' };
  const run = spawnSync('bash', [UPGRADE, f.manifestPath, f.signaturePath], { env, encoding: 'utf8' });
  assert.notEqual(run.status, 0); assert.equal(fs.readFileSync(env.MOCK_AGENT_STATE, 'utf8').trim(), 'agent-old123456');
  assert.equal(fs.existsSync(path.join(f.state, 'CURRENT_RELEASE.json')), false);
  const swaps = fs.readFileSync(env.MOCK_DOCKER_LOG, 'utf8').split('\n').filter(line => /compose .*--no-deps.* agent/.test(line));
  assert.equal(swaps.length, 2);
});

test('CLI defaults to stable and only accepts stable or canary', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-cli-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const env = { ...process.env, HIVEMIND_MEMORY_BOX_CONFIG_DIR: path.join(root, 'etc'), HIVEMIND_MEMORY_BOX_STATE_DIR: path.join(root, 'state'), HIVEMIND_MEMORY_BOX_LOCK_FILE: path.join(root, 'lock') };
  assert.equal(execFileSync('bash', [CLI, 'channel'], { env, encoding: 'utf8' }).trim(), 'stable');
  execFileSync('bash', [CLI, 'channel', 'canary'], { env });
  assert.equal(execFileSync('bash', [CLI, 'channel'], { env, encoding: 'utf8' }).trim(), 'canary');
  assert.notEqual(spawnSync('bash', [CLI, 'channel', 'beta'], { env }).status, 0);
});

test('host contract schedules persistent six-hour checks and forbids dependency restarts', () => {
  const timer = fs.readFileSync(path.join(BYOD, 'systemd/hivemind-memory-box-update.timer'), 'utf8');
  const upgrade = fs.readFileSync(UPGRADE, 'utf8');
  const cli = fs.readFileSync(CLI, 'utf8');
  assert.match(timer, /OnUnitActiveSec=6h/); assert.match(timer, /RandomizedDelaySec=30min/); assert.match(timer, /Persistent=true/);
  assert.match(upgrade, /--no-deps --force-recreate agent/); assert.doesNotMatch(upgrade, /compose[^\n]* down|\$\{HM_COMPOSE\[@\]\}[^\n]* down/);
  assert.match(cli, /\/v1\/selfhost\/report/);
  assert.match(cli, /apiKey:process\.env\.HIVEMIND_API_KEY/);
  assert.match(cli, /protocol_version:r\.protocol_version/);
  assert.match(cli, /last_success_at:r\.verified_at/);
  for (const command of ['install', 'update', 'status', 'doctor', 'rollback', 'channel']) assert.match(cli, new RegExp(`\\b${command}\\)`));
});

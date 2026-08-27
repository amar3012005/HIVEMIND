import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const BYOD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(BYOD, file), 'utf8');

test('first install is signed-first and cannot locally build or float the agent image', () => {
  const install = read('install.sh');
  const setup = read('setup.sh');
  const compose = read('docker-compose.byod.yml');
  assert.match(install, /verify-release\.mjs/);
  assert.match(install, /BYOD_INITIAL_AGENT_IMAGE="\$INITIAL_IMAGE"/);
  assert.match(install, /bootstrap-release\.env/);
  assert.match(install, /BYOD_BOOTSTRAP_RELEASE_FILE="\$BOOTSTRAP_RELEASE_FILE"/);
  assert.ok(install.lastIndexOf('systemctl enable --now') > install.lastIndexOf('hivemind-memory-box update'));
  assert.match(setup, /digest-pinned signed agent image is required/);
  assert.match(setup, /BOOTSTRAP_RELEASE_FILE/);
  assert.match(setup, /hm_load_env_file "\$BOOTSTRAP_RELEASE_FILE"/);
  assert.match(setup, /pull agent postgres qdrant/);
  assert.doesNotMatch(setup, /compose\.byod\.yml build|\$COMPOSE build/);
  assert.match(compose, /HIVEMIND_AGENT_IMAGE:\?signed HIVEMIND_AGENT_IMAGE is required/);
  assert.doesNotMatch(compose, /agent:\n\s+build:/);
});

test('setup proves local health and central reachability before reporting connected', () => {
  const setup = read('setup.sh');
  assert.match(setup, /LOCAL_READY=false/);
  assert.match(setup, /agent did not become healthy/);
  assert.match(setup, /REMOTE_READY=false/);
  assert.match(setup, /registered===true&&x\.reachable===true/);
  assert.match(setup, /not centrally reachable/);
  assert.ok(setup.indexOf('[[ "$REMOTE_READY" == true ]]') < setup.indexOf('Memory Box connected'));
});

test('one-command enrollment defaults to a private managed Cloudflare tunnel while preserving legacy transports', () => {
  const setup = read('setup.sh');
  const compose = read('docker-compose.byod.yml');
  assert.match(setup, /HIVEMIND_ENROLLMENT_TOKEN/);
  assert.match(setup, /enrollmentToken/);
  assert.match(setup, /HIVEMIND_BOX_TOKEN/);
  assert.match(setup, /--profile cloudflare up -d/);
  assert.match(setup, /--profile tailnet up -d/);
  assert.match(compose, /network_mode: "service:agent"/);
  assert.match(setup, /AGENT_PUBLIC_URL/);
  assert.match(compose, /cloudflare\/cloudflared@sha256:[a-f0-9]{64}/);
  assert.match(compose, /postgres@sha256:[a-f0-9]{64}/);
  assert.match(compose, /qdrant\/qdrant@sha256:[a-f0-9]{64}/);
  assert.match(compose, /tailscale\/tailscale@sha256:[a-f0-9]{64}/);
  assert.match(compose, /AGENT_BIND:-127\.0\.0\.1/);
});

test('upgrade, rollback and backup preserve the governed runtime contract', () => {
  const upgrade = read('upgrade.sh');
  const rollback = read('rollback.sh');
  const backup = read('backup.sh');
  assert.match(upgrade, /hm_set_env_value .*HIVEMIND_AGENT_IMAGE/);
  assert.match(upgrade, /hm_set_env_value .*VERSION/);
  assert.match(rollback, /rolled-back receipt has no digest-pinned signed image/);
  assert.match(rollback, /hm_set_env_value .*HIVEMIND_AGENT_IMAGE/);
  assert.match(backup, /memory-box-common\.sh/);
  assert.match(backup, /hm_compose_prefix/);
});

test('protected configuration is parsed as data and cannot execute shell syntax', () => {
  const common = path.join(BYOD, 'memory-box-common.sh');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-box-env-'));
  const marker = path.join(temp, 'executed');
  const envFile = path.join(temp, 'memory-box.env');
  fs.writeFileSync(envFile, `HIVEMIND_API_KEY=$(touch ${marker})\n`);
  const result = spawnSync('bash', ['-c', `. "${common}"; hm_load_env_file "$1"`, 'test', envFile], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(marker), false);
});

test('configuration writer rejects values Docker Compose could reinterpret', () => {
  const common = path.join(BYOD, 'memory-box-common.sh');
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-box-env-'));
  const envFile = path.join(temp, 'memory-box.env');
  const result = spawnSync('bash', ['-c', `. "${common}"; hm_set_env_value "$1" HIVEMIND_API_KEY '$$(id)'`, 'test', envFile], { encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.equal(fs.existsSync(envFile), false);
});

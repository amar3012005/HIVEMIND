import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BYOD = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(BYOD, file), 'utf8');

test('first install is signed-first and cannot locally build or float the agent image', () => {
  const install = read('install.sh');
  const setup = read('setup.sh');
  const compose = read('docker-compose.byod.yml');
  assert.match(install, /verify-release\.mjs/);
  assert.match(install, /BYOD_INITIAL_AGENT_IMAGE="\$INITIAL_IMAGE"/);
  assert.ok(install.lastIndexOf('systemctl enable --now') > install.lastIndexOf('hivemind-memory-box update'));
  assert.match(setup, /digest-pinned signed BYOD_INITIAL_AGENT_IMAGE is required/);
  assert.match(setup, /\$COMPOSE pull agent postgres qdrant/);
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
  assert.match(setup, /HIVEMIND cannot reach/);
  assert.ok(setup.indexOf('[[ "$REMOTE_READY" == true ]]') < setup.indexOf('ok "agent registered"'));
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

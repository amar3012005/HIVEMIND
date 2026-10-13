import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const helper = readFileSync(new URL('./release-canonical.sh', import.meta.url), 'utf8');
const compose = readFileSync(new URL('../infra/docker-compose.hetzner.yml', import.meta.url), 'utf8');
const expression = helper.match(/^sed "([^"\n]+)" "\$REL\/infra\/docker-compose\.hetzner\.yml"/m)?.[1];
assert.ok(expression, 'canonical materialization command must be identifiable');
const managedPath = '/root/hivemind/.env';

test('immutable release resolves every shared environment path including optional relay entries', () => {
  const result = spawnSync('sed', [expression.replace('$ENVF', managedPath)], { input: compose, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /env_file:\s*\[\.\.\/\.env/);
  assert.match(result.stdout, /env_file: \[\/root\/hivemind\/\.env, \{ path: "\$\{OPEN_DOT_RUNTIME_BRIDGE_ENV_FILE:-\/root\/hivemind\/secrets\/open-dot-runtime-bridge.env\}", required: false \}\]/);
  assert.equal((result.stdout.match(/env_file: \[\/root\/hivemind\/\.env/g) || []).length,
    (compose.match(/env_file: \[\.\.\/\.env/g) || []).length);
  // Only path references change; all networks, mounts, ingress and health stay intact.
  assert.equal(result.stdout.replaceAll(managedPath, '../.env'), compose);
});

test('old bracket-only substitution reproduces the Control Plane missing-worktree-env failure', () => {
  const old = spawnSync('sed', [`s#env_file: \\[../.env\\]#env_file: [${managedPath}]#g`], { input: compose, encoding: 'utf8' });
  assert.equal(old.status, 0, old.stderr);
  assert.match(old.stdout, /env_file: \[\.\.\/\.env, \{ path:/);
});

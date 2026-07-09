import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');
const read = (file) => fs.readFileSync(path.join(repoRoot, file), 'utf8');

test('vNext deployment separates B2B and B2C app/control/worker pools', () => {
  const text = read('infra/docker-compose.next.yml');
  for (const name of ['core-b2b', 'control-b2b', 'maintenance-b2b', 'employees-b2b', 'core-b2c', 'control-b2c', 'maintenance-b2c', 'employees-b2c']) {
    assert.match(text, new RegExp(`\\n  ${name}:`));
  }
  assert.match(text, /profiles: \[b2b\]/);
  assert.match(text, /profiles: \[b2c\]/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE: app/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE: maintenance/);
});

test('vNext deployment uses distinct state volumes, loopback ports, and mandatory isolated configuration', () => {
  const text = read('infra/docker-compose.next.yml');
  assert.match(text, /postgres-next-data/);
  assert.match(text, /qdrant-next-data/);
  assert.match(text, /redis-next-data/);
  assert.match(text, /127\.0\.0\.1:\$\{NEXT_B2B_CORE_PORT:-2126\}:3000/);
  assert.match(text, /127\.0\.0\.1:\$\{NEXT_B2C_CONTROL_PORT:-2227\}:3000/);
  assert.match(text, /NEXT_DATABASE_URL:\?set NEXT_DATABASE_URL to the isolated vNext database/);
  assert.doesNotMatch(text, /hivemind-data/);
  assert.doesNotMatch(text, /CORE_PORT:-2026/);
  assert.doesNotMatch(text, /CONTROL_PORT:-2027/);
});

test('vNext Caddy hosts preserve production hosts and point only at vNext loopback ports', () => {
  const text = read('infra/Caddyfile.next.snippet');
  for (const host of ['b2b-next-core', 'b2b-next-api', 'b2c-next-core', 'b2c-next-api']) {
    assert.match(text, new RegExp(`${host}\\.singulancelabs\\.com`));
  }
  for (const port of ['2126', '2127', '2226', '2227']) assert.match(text, new RegExp(`localhost:${port}`));
  assert.doesNotMatch(text, /reverse_proxy localhost:202[67]/);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..', '..', '..');

function read(file) {
  return fs.readFileSync(path.join(repoRoot, file), 'utf8');
}

test('deploy/docker-compose.coolify.yml encodes app, maintenance, and sidecar runtime roles', () => {
  const text = read('deploy/docker-compose.coolify.yml');
  assert.match(text, /services:\s*\n\s*app:/);
  assert.match(text, /\n\s*maintenance:/);
  assert.match(text, /\n\s*sidecar:/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE=app/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE=maintenance/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE=sidecar/);
  assert.match(text, /HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS=true/);
  assert.match(text, /memory-maintenance-worker\.js/);
  assert.match(text, /app-sidecar-worker\.js/);
});

test('infra/docker-compose.production.yml encodes api, maintenance, and sidecar split', () => {
  const text = read('infra/docker-compose.production.yml');
  assert.match(text, /\n\s*api:/);
  assert.match(text, /\n\s*api-maintenance:/);
  assert.match(text, /\n\s*api-sidecar:/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE=app/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE=maintenance/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE=sidecar/);
  assert.match(text, /HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS=true/);
  assert.match(text, /memory-maintenance-worker\.js/);
  assert.match(text, /app-sidecar-worker\.js/);
});

test('docker-compose.coolify.yml encodes app, maintenance, and sidecar worker split', () => {
  const text = read('docker-compose.coolify.yml');
  assert.match(text, /\n\s*app:/);
  assert.match(text, /\n\s*app-maintenance:/);
  assert.match(text, /\n\s*app-sidecar:/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE:\s+app/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE:\s+maintenance/);
  assert.match(text, /HIVEMIND_RUNTIME_ROLE:\s+sidecar/);
  assert.match(text, /HIVEMIND_REQUIRE_QUEUED_KB_UPLOADS:\s+'true'/);
  assert.match(text, /memory-maintenance-worker\.js/);
  assert.match(text, /app-sidecar-worker\.js/);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');

test('first local Compose validation does not require an inactive OIDC profile', () => {
  const compose = fs.readFileSync(path.join(root, 'compose.yaml'), 'utf8');
  assert.match(compose, /OAUTH2_PROXY_OIDC_ISSUER_URL: \$\{ENGINE_BOX_OIDC_ISSUER:-\}/);
  assert.match(compose, /OAUTH2_PROXY_CLIENT_ID: \$\{ENGINE_BOX_OIDC_CLIENT_ID:-\}/);
  assert.match(compose, /OAUTH2_PROXY_REDIRECT_URL: \$\{ENGINE_BOX_OIDC_REDIRECT_URL:-\}/);
});

test('one-command bootstrap redeems through the versioned control-plane API', () => {
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  const worker = fs.readFileSync(path.join(root, 'control-plane/src/index.ts'), 'utf8');
  assert.match(installer, /ENGINE_BOX_MANAGEMENT_BASE:-https:\/\/api\.singulancelabs\.com\/v1\/engine-box/);
  assert.match(installer, /"\$MANAGEMENT_BASE\/bootstrap"/);
  assert.match(worker, /url\.pathname === '\/v1\/engine-box\/bootstrap'/);
  assert.match(installer, /signed release manifest lacks pinned Docker version/);
  assert.match(installer, /ENGINE_BOX_DOCKER_VERSION/);
});

test('bootstrap liveness precedes local configuration, while activation requires readiness', () => {
  const supervisor = fs.readFileSync(path.join(root, 'supervisor/src/main.rs'), 'utf8');
  const installer = fs.readFileSync(path.join(root, 'install.sh'), 'utf8');
  assert.match(supervisor, /"install" => \{[\s\S]*wait_for_local_health/);
  assert.match(supervisor, /"activate" => wait_for_local_ready/);
  assert.match(installer, /not READY until the local setup wizard completes/);
});

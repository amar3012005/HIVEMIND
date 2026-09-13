import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const controlPlaneUrl = new URL('../../src/control-plane-server.js', import.meta.url);
const composeUrl = new URL('../../../infra/docker-compose.hetzner.yml', import.meta.url);

test('browser-facing Composio routes are user scoped', async () => {
  const source = await readFile(controlPlaneUrl, 'utf8');
  const browserRoutes = source.slice(
    source.indexOf('// Overlay Composio-backed LIVE connectors'),
    source.indexOf('const whatsappQrRoute'),
  );

  assert.match(browserRoutes, /listConnectedAccounts\(orgId, \{\s*userId: current\.session\.userId,\s*connectionScope: 'user'/);
  assert.match(browserRoutes, /createConnectLink\(toolkitSlug, orgId, \{\s*userId: current\.session\.userId,\s*connectionScope: 'user'/);
  assert.match(browserRoutes, /createApiKeyConnection\(orgId, toolkitSlug, apiKey, \{\s*userId: current\.session\.userId,\s*connectionScope: 'user'/);
  assert.match(browserRoutes, /disconnectToolkit\(orgId, toolkitSlug, \{\s*userId: current\.session\.userId,\s*connectionScope: 'user'/);
  assert.match(browserRoutes, /connection_scope: 'user'/);
});

test('Core and Control Plane receive the server-held Composio configuration', async () => {
  const compose = await readFile(composeUrl, 'utf8');
  const core = compose.slice(compose.indexOf('\n  core:'), compose.indexOf('\n  ingestion-worker:'));
  const control = compose.slice(compose.indexOf('\n  control-plane:'), compose.indexOf('\n  harness-runner:'));

  for (const service of [core, control]) {
    assert.match(service, /COMPOSIO_API_KEY: \$\{COMPOSIO_API_KEY:-\}/);
    assert.match(service, /COMPOSIO_AUTH_CONFIGS: \$\{COMPOSIO_AUTH_CONFIGS:-\{\}\}/);
  }
});

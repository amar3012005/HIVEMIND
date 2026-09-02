import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createEngineBoxServer, probeEngineBoxServices } from '../../src/engine-box/lean-server.mjs';

const readyServices = { postgres: 'ready', qdrant: 'ready', redis: 'ready', hm_extract: 'ready', model_router: 'ready', core: 'ready', control_plane: 'ready', ingestion: 'ready', mcp: 'ready', edge: 'ready' };

test('lean Engine Core exposes only liveness and local readiness before feature routes are composed', async () => {
  const server = createEngineBoxServer({ runtime: { apiVersion: 'v1' }, serviceProbe: async () => readyServices, lease: { expiresAt: '2030-01-01T00:00:00Z' } });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const get = (path) => new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}${path}`, (response) => {
    let body = ''; response.on('data', (chunk) => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
  }).on('error', reject));
  assert.equal((await get('/health')).status, 200);
  assert.equal((await get('/ready')).body.state, 'READY');
  assert.equal((await get('/v1/chat')).status, 404);
  await new Promise((resolve) => server.close(resolve));
});

test('lean readiness reports a missing required data-plane dependency', async () => {
  const services = await probeEngineBoxServices({
    prisma: null,
    qdrantUrl: 'http://invalid.test',
    modelRouterUrl: 'http://invalid.test',
    probes: { postgres: async () => 'unavailable', qdrant: async () => 'ready', redis: async () => 'ready', extract: async () => 'ready', modelRouter: async () => 'ready' },
  });
  assert.equal(services.postgres, 'unavailable');
});

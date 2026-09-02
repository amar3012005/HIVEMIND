import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createEngineBoxControlPlane } from '../../src/engine-box/control-plane-server.mjs';

function get(port, path) {
  return new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}${path}`, (response) => {
    let body = ''; response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
  }).on('error', reject));
}

test('lean local control plane has no hosted routes and reports only real local readiness', async () => {
  const server = createEngineBoxControlPlane({
    runtime: { apiVersion: 'v1', capabilities: ['identity', 'rbac', 'api_keys', 'licence', 'admin', 'audit', 'connectors'] },
    postgresProbe: async () => 'ready',
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  const ready = await get(port, '/ready');
  assert.equal(ready.status, 200);
  assert.deepEqual(ready.body.capabilities, ['identity', 'rbac', 'api_keys', 'licence', 'admin', 'audit']);
  assert.equal((await get(port, '/v1/connectors')).status, 404);
  await new Promise((resolve) => server.close(resolve));
});

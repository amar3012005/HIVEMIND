import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEngineBoxControlPlane } from '../../src/engine-box/control-plane-server.mjs';

function get(port, path) {
  return new Promise((resolve, reject) => http.get(`http://127.0.0.1:${port}${path}`, (response) => {
    let body = ''; response.on('data', (chunk) => { body += chunk; });
    response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(body) }));
  }).on('error', reject));
}

test('lean local control plane has no hosted routes and stays unready before local activation', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-box-control-'));
  const token = path.join(root, 'setup-token'); const key = path.join(root, 'state-key');
  await fs.writeFile(token, 'x'.repeat(32)); await fs.writeFile(key, crypto.randomBytes(32).toString('base64'));
  const server = createEngineBoxControlPlane({
    runtime: { apiVersion: 'v1', capabilities: ['identity', 'rbac', 'api_keys', 'licence', 'admin', 'audit', 'connectors'] },
    postgresProbe: async () => 'ready',
    env: { ENGINE_BOX_STATE_DIR: path.join(root, 'state'), ENGINE_BOX_SETUP_TOKEN_FILE: token, ENGINE_BOX_STATE_KEY_FILE: key },
  });
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;
    const ready = await get(port, '/ready');
    assert.equal(ready.status, 503);
    assert.deepEqual(ready.body.capabilities, ['identity', 'rbac', 'api_keys', 'licence', 'admin', 'audit']);
    assert.equal((await get(port, '/v1/connectors')).status, 404);
  } finally {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  }
});

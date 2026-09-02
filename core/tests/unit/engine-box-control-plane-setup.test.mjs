import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createEngineBoxControlPlane } from '../../src/engine-box/control-plane-server.mjs';

const validSetup = {
  oidc: { issuer: 'https://id.example.test', client_id: 'engine-box', client_secret: 'secret', redirect_url: 'https://localhost/oauth2/callback', group_mapping: { owner: ['owners'] } },
  model_routes: {
    embedding: { execution: 'local', base_url: 'https://models.example.test', model: 'embed', dimension: 1024 },
    rerank: { execution: 'local', base_url: 'https://models.example.test', model: 'rerank' },
    chat: { execution: 'local', base_url: 'https://models.example.test', model: 'chat' },
  },
  backup: { destination: 'file:///safe-backups', encryption_key_reference: 'kms://customer/key' },
};

async function setupServer() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-box-control-'));
  const token = path.join(root, 'setup-token'); const key = path.join(root, 'state-key');
  await fs.writeFile(token, 'x'.repeat(32)); await fs.writeFile(key, crypto.randomBytes(32).toString('base64'));
  const env = { ENGINE_BOX_STATE_DIR: path.join(root, 'state'), ENGINE_BOX_SETUP_TOKEN_FILE: token, ENGINE_BOX_STATE_KEY_FILE: key };
  const server = createEngineBoxControlPlane({ runtime: { apiVersion: 'v1', capabilities: ['identity', 'rbac', 'api_keys', 'licence', 'admin', 'audit'] }, postgresProbe: async () => 'ready', env,
    canaryRunner: async () => ({ state: 'passed', receipt_id: 'canary-1' }) });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { root, server, url: `http://127.0.0.1:${server.address().port}` };
}

test('Engine Box local setup cannot activate before an authenticated setup and canary', async () => {
  const fixture = await setupServer();
  try {
    let response = await fetch(`${fixture.url}/v1/setup/configure`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(validSetup) });
    assert.equal(response.status, 401);
    response = await fetch(`${fixture.url}/setup`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Set up your HIVEMIND Engine Box/);
    response = await fetch(`${fixture.url}/v1/setup/configure`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-engine-box-setup-token': 'x'.repeat(32) }, body: JSON.stringify(validSetup) });
    assert.equal(response.status, 201);
    assert.ok(!(await response.text()).includes('"secret"'));
    response = await fetch(`${fixture.url}/v1/setup/activate`, { method: 'POST', headers: { 'x-engine-box-setup-token': 'x'.repeat(32) } });
    assert.equal(response.status, 200);
    await response.text();
    response = await fetch(`${fixture.url}/ready`);
    assert.equal(response.status, 200);
    await response.text();
  } finally {
    fixture.server.closeAllConnections?.();
    await new Promise((resolve) => fixture.server.close(resolve));
    await fs.rm(fixture.root, { recursive: true, force: true });
  }
});

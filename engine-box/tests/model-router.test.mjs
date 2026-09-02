import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { canonicalize } from '../lib/model-catalog.mjs';
import { writeSetupRecord } from '../lib/local-state.mjs';
import { inferModel, probeConfiguredRoutes } from '../model-router/server.mjs';

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'engine-box-router-'));
  const pair = crypto.generateKeyPairSync('ed25519');
  const catalog = { catalogVersion: 1, routes: [
    { routeId: 'embed-local', capability: 'embedding', execution: 'local', provider: 'customer', model: 'catalog-embed', protocol: 'openai-embeddings', dimension: 3, dataEgress: 'none', fallbackGroup: 'embed-3', healthPath: '/health' },
    { routeId: 'rerank-local', capability: 'rerank', execution: 'local', provider: 'customer', model: 'catalog-rerank', protocol: 'openai-compatible', dataEgress: 'none', fallbackGroup: 'rerank', healthPath: '/health' },
    { routeId: 'chat-local', capability: 'chat', execution: 'local', provider: 'customer', model: 'catalog-chat', protocol: 'openai-compatible', dataEgress: 'none', fallbackGroup: 'chat', healthPath: '/health' },
  ] };
  const catalogPath = path.join(root, 'catalog.json'); const signaturePath = path.join(root, 'catalog.sig'); const publicKeyPath = path.join(root, 'release.pub');
  await fs.writeFile(catalogPath, JSON.stringify(catalog));
  await fs.writeFile(signaturePath, crypto.sign(null, Buffer.from(canonicalize(catalog)), pair.privateKey).toString('base64'));
  await fs.writeFile(publicKeyPath, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  const key = path.join(root, 'state-key'); await fs.writeFile(key, crypto.randomBytes(32).toString('base64'));
  const env = { ENGINE_BOX_STATE_DIR: path.join(root, 'state'), ENGINE_BOX_STATE_KEY_FILE: key, MODEL_CATALOG_PATH: catalogPath, MODEL_CATALOG_SIGNATURE_PATH: signaturePath, RELEASE_PUBLIC_KEY_PATH: publicKeyPath };
  await writeSetupRecord({ state: 'configured', model_routes: {
    embedding: { execution: 'local', base_url: 'https://models.local/v1', model: 'customer-embed', dimension: 3, api_key: 'not-exposed' },
    rerank: { execution: 'local', base_url: 'https://models.local/v1', model: 'customer-rerank' },
    chat: { execution: 'local', base_url: 'https://models.local/v1', model: 'customer-chat' },
  } }, env);
  return { root, env };
}

test('model router only forwards to encrypted configured local routes and validates embedding dimensions', async () => {
  const { root, env } = await fixture();
  try {
    let request;
    const result = await inferModel({ capability: 'embedding', input: ['one', 'two'] }, { env, fetchImpl: async (url, init) => {
      request = { url, init: JSON.parse(init.body), auth: init.headers.authorization };
      return new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }, { embedding: [4, 5, 6] }] }), { status: 200 });
    } });
    assert.equal(request.url, 'https://models.local/v1/embeddings');
    assert.equal(request.init.model, 'customer-embed');
    assert.equal(request.auth, 'Bearer not-exposed');
    assert.equal(result.route.api_key, undefined);
    assert.deepEqual(result.vectors[0], [1, 2, 3]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test('model router readiness probes every configured local capability', async () => {
  const { root, env } = await fixture();
  try {
    const calls = [];
    const routes = await probeConfiguredRoutes({ env, fetchImpl: async (url) => {
      calls.push(url);
      return new Response('', { status: 200 });
    } });
    assert.equal(routes.length, 3);
    assert.deepEqual(calls, ['https://models.local/health', 'https://models.local/health', 'https://models.local/health']);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

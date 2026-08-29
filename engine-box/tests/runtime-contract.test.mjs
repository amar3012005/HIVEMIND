import assert from 'node:assert/strict';
import test from 'node:test';
import crypto from 'node:crypto';
import { createEngineBoxRuntimeConfig, evaluateReadiness } from '../lib/runtime-contract.mjs';
import { canonicalize, selectModelRoute, validateModelCatalog, verifySignedCatalog } from '../lib/model-catalog.mjs';

const localServices = Object.fromEntries(['postgres', 'qdrant', 'redis', 'core', 'ingestion', 'hm_extract', 'mcp'].map((name) => [name, 'ready']));
const catalog = { catalogVersion: 1, routes: [
  { routeId: 'local-embed', capability: 'embedding', execution: 'local', dimension: 1024, dataEgress: 'none' },
  { routeId: 'cloud-embed', capability: 'embedding', execution: 'cloudflare_gateway', dimension: 1024, dataEgress: 'opt_in' },
] };

test('Engine Box refuses hosted-only capability boot', () => {
  assert.throws(() => createEngineBoxRuntimeConfig({ ENGINE_BOX_MODE: 'true', ENGINE_BOX_ENABLE: 'ingestion,voice' }), /hosted-only/);
});

test('Engine Box is ready only with local dependencies, a valid lease, and an allowed model route', () => {
  const result = evaluateReadiness({ services: localServices, modelRoute: { execution: 'local' }, license: { expiresAt: '2030-01-01T00:00:00Z' } });
  assert.equal(result.state, 'READY');
  const expired = evaluateReadiness({ services: localServices, modelRoute: { execution: 'local' }, license: { expiresAt: '2020-01-01T00:00:00Z' } });
  assert.equal(expired.state, 'DEGRADED');
  assert.equal(expired.lease.mode, 'read_only');
});

test('Cloudflare routes require explicit consent while sovereign routes do not', () => {
  validateModelCatalog(catalog);
  assert.equal(selectModelRoute(catalog, 'embedding').routeId, 'local-embed');
  assert.throws(() => selectModelRoute(catalog, 'embedding', { routeId: 'cloud-embed' }), /consent/);
  assert.equal(selectModelRoute(catalog, 'embedding', { routeId: 'cloud-embed', consent: true }).egressConsent, true);
});

test('signed catalog verification is deterministic', () => {
  const keys = crypto.generateKeyPairSync('ed25519');
  const signature = crypto.sign(null, Buffer.from(canonicalize(catalog)), keys.privateKey).toString('base64');
  assert.equal(verifySignedCatalog({ catalog, signature, publicKey: keys.publicKey }), true);
  assert.equal(verifySignedCatalog({ catalog: { ...catalog, catalogVersion: 2 }, signature, publicKey: keys.publicKey }), false);
});

import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { describe, it } from 'node:test';
import { EdgeCapabilityClient } from '../../src/cloudflare/edge-capability-client.js';
import { DEFAULT_EDGE_CAPABILITIES, resolveEdgeCapabilities, stableJson, verifySignedEdgeEntitlement } from '../../src/cloudflare/edge-entitlement.js';

const ORG = '11111111-1111-4111-8111-111111111111';
function signed(flags = { cloudflare_edge: true }) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519');
  const document = { version: 1, organization_id: ORG, issued_at: '2026-09-06T00:00:00.000Z', expires_at: '2026-10-06T00:00:00.000Z', nonce: 'abcdefghijklmnop', flags };
  return { publicKey: publicKey.export({ type: 'spki', format: 'pem' }), envelope: { document, signature: sign(null, Buffer.from(stableJson(document)), privateKey).toString('base64') } };
}

describe('Cloudflare edge entitlement', () => {
  it('is fail-closed until both the local flag and signature are valid', () => {
    const { publicKey, envelope } = signed();
    const verified = verifySignedEdgeEntitlement({ envelope, organizationId: ORG, publicKey, now: new Date('2026-09-07T00:00:00.000Z') });
    assert.equal(verified.valid, true);
    assert.deepEqual(resolveEdgeCapabilities({ featureEnabled: false, entitlement: verified }), DEFAULT_EDGE_CAPABILITIES);
    assert.equal(resolveEdgeCapabilities({ featureEnabled: true, entitlement: verified }).cloudflare_edge, true);
  });

  it('rejects a modified document and never enables a capability', () => {
    const { publicKey, envelope } = signed();
    envelope.document.flags.cloudflare_ai_gateway = true;
    const verified = verifySignedEdgeEntitlement({ envelope, organizationId: ORG, publicKey, now: new Date('2026-09-07T00:00:00.000Z') });
    assert.equal(verified.valid, false);
    assert.deepEqual(verified.flags, DEFAULT_EDGE_CAPABILITIES);
  });

  it('fails closed when the optional Cloudflare endpoint is unavailable', async () => {
    const client = new EdgeCapabilityClient({
      baseUrl: 'https://control.example', token: 'test', publicKey: 'test', featureEnabled: true,
      fetchImpl: async () => { throw new Error('network unavailable'); },
    });
    assert.deepEqual(await client.getCapabilities(ORG), DEFAULT_EDGE_CAPABILITIES);
  });
});

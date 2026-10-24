import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { verifyConnectionOwnership } from '../../src/connectors/mcp/nango-service.js';

const userA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const userB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const orgA = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const orgB = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const owned = (endUser, extra = {}) => async () => ({ connection_id: 'conn-1', provider_config_key: 'notion', end_user: endUser, ...extra });

test('a connection owned by user A cannot be finalized by user B', async () => {
  const get = owned({ id: userA, organization: { id: orgA } });
  assert.deepEqual(
    await verifyConnectionOwnership({ providerKey: 'notion', connectionId: 'conn-1', userId: userB, orgId: orgA }, { get }),
    { ok: false, reason: 'connection_owner_mismatch' },
  );
});

test('a connection from another organization is rejected', async () => {
  const get = owned({ id: userA, organization: { id: orgB } });
  assert.equal((await verifyConnectionOwnership({ providerKey: 'notion', connectionId: 'conn-1', userId: userA, orgId: orgA }, { get })).ok, false);
});

test('a connection with no recorded owner, another provider, or an unknown id is rejected', async () => {
  assert.equal((await verifyConnectionOwnership({ providerKey: 'notion', connectionId: 'conn-1', userId: userA, orgId: orgA }, { get: owned(null) })).ok, false);
  assert.equal((await verifyConnectionOwnership({ providerKey: 'notion', connectionId: 'conn-1', userId: userA, orgId: orgA }, {
    get: async () => ({ provider_config_key: 'github', end_user: { id: userA } }),
  })).reason, 'connection_owner_mismatch');
  assert.equal((await verifyConnectionOwnership({ providerKey: 'notion', connectionId: 'missing', userId: userA }, {
    get: async () => { throw new Error('Nango GET /connection/missing 404: not found'); },
  })).reason, 'connection_not_found');
  assert.equal((await verifyConnectionOwnership({ providerKey: 'notion', connectionId: 'conn-1', userId: userA }, {
    get: async () => { throw new Error('fetch failed'); },
  })).reason, 'connection_unverifiable');
});

test('the Connect-session owner can finalize, via end_user or tags', async () => {
  assert.deepEqual(await verifyConnectionOwnership({ providerKey: 'notion', connectionId: 'conn-1', userId: userA, orgId: orgA }, {
    get: owned({ id: userA, organization: { id: orgA } }),
  }), { ok: true });
  assert.deepEqual(await verifyConnectionOwnership({ providerKey: 'notion', connectionId: 'conn-1', userId: userA, orgId: orgA }, {
    get: async () => ({ provider_config_key: 'notion', end_user: null, tags: { end_user_id: userA, organization_id: orgA } }),
  }), { ok: true });
});

test('Core verifies ownership before it upserts the Nango connection', () => {
  const server = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const route = server.slice(server.indexOf("case '/api/connectors/connect':"));
  const verify = route.indexOf('verifyConnectionOwnership({ providerKey, connectionId, userId, orgId })');
  assert.ok(verify > 0 && verify < route.indexOf('prisma.nangoConnection.upsert'));
});

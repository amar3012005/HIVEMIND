import test from 'node:test';
import assert from 'node:assert/strict';
import { OAuthStateStore } from '../../src/oauth/oauth-state-store.js';

const config = {
  codeTtlSeconds: 60,
  refreshTtlSeconds: 120,
  redisUrl: null,
  redisHost: null,
  redisPort: 6379,
  redisPassword: null,
  requireDurableInProduction: false,
};

function createRedisStub() {
  const values = new Map();
  return {
    async set(key, value) { values.set(key, value); },
    async get(key) { return values.get(key) || null; },
    async getdel(key) {
      const value = values.get(key) || null;
      values.delete(key);
      return value;
    },
  };
}

test('oauth state store keeps authorization codes single-use in memory fallback', async () => {
  const store = new OAuthStateStore(config);
  await store.storeAuthorizationCode('code-1', { clientId: 'client-a', expiresAt: Date.now() + 60_000 });

  const first = await store.consumeAuthorizationCode('code-1');
  assert.equal(first.clientId, 'client-a');

  const second = await store.consumeAuthorizationCode('code-1');
  assert.equal(second, null);
});

test('oauth state store persists and revokes refresh-token records in memory fallback', async () => {
  const store = new OAuthStateStore(config);
  await store.storeRefreshTokenRecord({
    refreshHash: 'hash-1',
    clientId: 'client-a',
    expiresAt: Date.now() + 120_000,
    revokedAt: null,
  });

  const before = await store.loadRefreshTokenRecord('hash-1');
  assert.equal(before.clientId, 'client-a');
  assert.equal(before.revokedAt, null);

  await store.revokeRefreshToken('hash-1', '2026-07-09T00:00:00.000Z');
  const after = await store.loadRefreshTokenRecord('hash-1');
  assert.equal(after.revokedAt, '2026-07-09T00:00:00.000Z');
});

test('oauth state store fails closed in production when durable storage is unavailable', async () => {
  const prev = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  const store = new OAuthStateStore({
    ...config,
    requireDurableInProduction: true,
  });

  try {
    await assert.rejects(
      () => store.storeAuthorizationCode('code-prod', { expiresAt: Date.now() + 60_000 }),
      /required in production/,
    );
  } finally {
    if (prev === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = prev;
  }
});

test('oauth state survives a new store instance and is consumed only once', async () => {
  const redisClient = createRedisStub();
  const firstProcess = new OAuthStateStore({ ...config, redisClient });
  const secondProcess = new OAuthStateStore({ ...config, redisClient });

  await firstProcess.storeAuthorizationCode('code-restart', { clientId: 'client-a' });
  assert.deepEqual(await secondProcess.consumeAuthorizationCode('code-restart'), { clientId: 'client-a' });
  assert.equal(await firstProcess.consumeAuthorizationCode('code-restart'), null);
});

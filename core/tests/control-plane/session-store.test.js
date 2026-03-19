import test from 'node:test';
import assert from 'node:assert/strict';
import { ControlPlaneSessionStore, buildSessionCookie, verifySessionCookie } from '../../src/control-plane/session-store.js';

const config = {
  sessionTtlSeconds: 60,
  authStateTtlSeconds: 60,
  sessionSecret: 'test-secret',
  redisUrl: null,
  redisHost: null,
  redisPort: 6379,
  redisPassword: null
};

test('control-plane session cookies round-trip with signatures', () => {
  const cookie = buildSessionCookie(config.sessionSecret, 'session-123');
  assert.equal(verifySessionCookie(config.sessionSecret, cookie), 'session-123');
});

test('control-plane session store keeps sessions and auth states in memory fallback', async () => {
  const store = new ControlPlaneSessionStore(config);
  const sessionId = await store.createSession({ userId: 'user-1', orgId: 'org-1' });
  const session = await store.getSession(sessionId);
  assert.equal(session.userId, 'user-1');

  const state = await store.createAuthState({ returnTo: '/welcome' });
  const consumed = await store.consumeAuthState(state);
  assert.equal(consumed.returnTo, '/welcome');
  const missing = await store.consumeAuthState(state);
  assert.equal(missing, null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { desktopAuthEnabled, desktopEnabledProviders, redisSupportsAtomicDesktopCodes, desktopChallenge, validDesktopNonce, validDesktopChallenge, validDesktopIssuedAt, validDesktopExchange } from '../../src/control-plane/desktop-auth.js';
import { ControlPlaneSessionStore } from '../../src/control-plane/session-store.js';

test('desktop auth rollout requires an explicit operator opt-in', () => {
  for (const value of [undefined, '', '0', 'true', 'TRUE', true, 1]) {
    assert.equal(desktopAuthEnabled(value), false);
  }
  assert.equal(desktopAuthEnabled('1'), true);
});

test('desktop login advertises only configured account providers', () => {
  assert.deepEqual(desktopEnabledProviders({ google: false, zitadel: false }), []);
  assert.deepEqual(desktopEnabledProviders({ google: true, zitadel: false }), ['google']);
  assert.deepEqual(desktopEnabledProviders({ google: false, zitadel: true }), ['zitadel']);
  assert.deepEqual(desktopEnabledProviders({ google: false, zitadel: true, idpHints: 'microsoft' }), ['microsoft', 'zitadel']);
  assert.deepEqual(desktopEnabledProviders({ google: false, zitadel: true, idpHints: 'microsoft,apple' }), ['microsoft', 'apple', 'zitadel']);
  assert.deepEqual(desktopEnabledProviders({ google: true, zitadel: false, idpHints: 'microsoft,apple' }), ['google']);
  assert.deepEqual(desktopEnabledProviders({ google: true, zitadel: true, idpHints: 'unknown' }), ['google', 'zitadel']);
});

test('desktop auth requires live Redis GETDEL support', async () => {
  let commands = 0;
  const client = (reply, status = 'ready') => ({ status, async call(...args) {
    commands += 1;
    assert.deepEqual(args, ['COMMAND', 'INFO', 'GETDEL']);
    return reply;
  } });
  assert.equal(await redisSupportsAtomicDesktopCodes(null), false);
  assert.equal(await redisSupportsAtomicDesktopCodes(client([['getdel']], 'end')), false);
  assert.equal(commands, 0);
  assert.equal(await redisSupportsAtomicDesktopCodes(client([null])), false);
  assert.equal(await redisSupportsAtomicDesktopCodes(client([])), false);
  assert.equal(await redisSupportsAtomicDesktopCodes(client([['get']])), false);
  assert.equal(await redisSupportsAtomicDesktopCodes(client([['getdel', 2]])), true);
  assert.equal(await redisSupportsAtomicDesktopCodes({ status: 'ready', call: async () => { throw Error('no permission'); } }), false);
});

test('one-time desktop code requires an exact client-held verifier', () => {
  const verifier = 'a'.repeat(43);
  const nonce = 'b'.repeat(43);
  const challenge = desktopChallenge(verifier);
  assert.equal(validDesktopChallenge(challenge), true);
  const codeRecord = { type: 'desktop-login-code', sessionId: 'session-1', nonce, challenge, issuedAt: Date.now() };
  assert.equal(validDesktopExchange({ codeRecord, state: nonce, verifier }), true);
  assert.equal(validDesktopExchange({ codeRecord, state: nonce, verifier: 'c'.repeat(43) }), false);
  assert.equal(validDesktopExchange({ codeRecord, state: 'x'.repeat(43), verifier }), false);
  assert.equal(validDesktopExchange({ codeRecord: { ...codeRecord, type: 'desktop-login-intent' }, state: nonce, verifier }), false);
  assert.equal(validDesktopNonce('short'), false);
  assert.equal(validDesktopIssuedAt(Date.now() - 11 * 60 * 1000), false);
  assert.equal(validDesktopExchange({ codeRecord: { ...codeRecord, issuedAt: Date.now() - 11 * 60 * 1000 }, state: nonce, verifier }), false);
});

test('configured but unavailable Redis cannot redeem a local fallback handoff code', async () => {
  const store = new ControlPlaneSessionStore({
    redisUrl: 'redis://127.0.0.1:1', authStateTtlSeconds: 600,
  });
  const code = await store.createAuthState({ type: 'desktop-login-code', sessionId: 's' });
  assert.equal(await store.consumeAuthStateOnce(code), null);
});

test('desktop authorization is consumed once, including concurrent exchanges', async () => {
  const store = new ControlPlaneSessionStore({ authStateTtlSeconds: 600 });
  const code = await store.createAuthState({ type: 'desktop-login-code', sessionId: 's' });
  const results = await Promise.all([store.consumeAuthStateOnce(code), store.consumeAuthStateOnce(code)]);
  assert.equal(results.filter(Boolean).length, 1);
  assert.equal(await store.consumeAuthStateOnce(code), null);
  assert.equal(await store.consumeAuthStateOnce('invalid'), null);
});

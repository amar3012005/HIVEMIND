import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { checkGmailStateBinding, GMAIL_CONNECT_STATE_PURPOSE } from '../../src/connectors/providers/gmail/oauth-session-binding.js';

const attacker = { userId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', orgId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc' };
const victim = { userId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', orgId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' };
const nonceFor = (principal) => ({ purpose: GMAIL_CONNECT_STATE_PURPOSE, ...principal });

test('a state minted for user A is rejected when user B completes consent', () => {
  const state = { ...attacker, nonce: 'n1' };
  assert.deepEqual(checkGmailStateBinding(state, victim, nonceFor(attacker)), { ok: false, reason: 'session_mismatch' });
});

test('a valid HMAC state without a browser session is rejected', () => {
  const state = { ...attacker, nonce: 'n1' };
  assert.deepEqual(checkGmailStateBinding(state, null, nonceFor(attacker)), { ok: false, reason: 'session_required' });
});

test('a session in another organization of the same user is rejected', () => {
  const state = { ...attacker, nonce: 'n1' };
  const session = { userId: attacker.userId, orgId: victim.orgId };
  assert.deepEqual(checkGmailStateBinding(state, session, nonceFor(attacker)), { ok: false, reason: 'session_mismatch' });
});

test('a consumed, expired, or foreign nonce is rejected', () => {
  const state = { ...attacker, nonce: 'n1' };
  assert.deepEqual(checkGmailStateBinding(state, attacker, null), { ok: false, reason: 'state_replayed' });
  assert.deepEqual(checkGmailStateBinding(state, attacker, nonceFor(victim)), { ok: false, reason: 'state_replayed' });
  assert.deepEqual(checkGmailStateBinding(state, attacker, { ...nonceFor(attacker), purpose: 'other' }), { ok: false, reason: 'state_replayed' });
});

test('the initiating principal completes consent', () => {
  const state = { ...attacker, nonce: 'n1' };
  assert.deepEqual(checkGmailStateBinding(state, attacker, nonceFor(attacker)), { ok: true });
  assert.deepEqual(checkGmailStateBinding(state, { userId: attacker.userId, orgId: null }, nonceFor(attacker)), { ok: true });
});

test('Core mints a one-time nonce at connect and checks the binding before exchanging the code', () => {
  const server = fs.readFileSync(new URL('../../src/server.js', import.meta.url), 'utf8');
  const callback = server.slice(server.indexOf("pathname === '/api/connectors/gmail/callback'"));
  const binding = callback.indexOf('checkGmailStateBinding(verified, callbackSession, nonceRecord)');
  const exchange = callback.indexOf('exchangeCode({ code: callbackCode');
  assert.ok(binding > 0 && exchange > binding);
  assert.match(callback, /resolveOAuthSession\(req\)/);
  assert.match(callback, /oauthSessionStore\.consumeAuthState\(verified\.nonce\)/);
  assert.match(server, /oauthSessionStore\.createAuthState\(\{ purpose: GMAIL_CONNECT_STATE_PURPOSE, userId, orgId \}\)/);
  assert.match(server, /signOAuthState\(\{ userId, orgId, targetScope, services, nonce: gmailNonce, _ts: Date\.now\(\) \}\)/);
});

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { isGoogleSignIn, admitSession, createBrowserSignIn } = require('../src/browser-sign-in');
const { setTimeout: delay } = require('node:timers/promises');

test('only first-party Google app-login navigations use desktop sign-in', () => {
  assert.ok(isGoogleSignIn('https://api.singulancelabs.com/auth/google?return_to=old', 'https://runtime-runner.singulancelabs.com/hivemind/login'));
  assert.equal(isGoogleSignIn('https://api.singulancelabs.com/auth/google', 'https://evil.example/'), false);
  assert.equal(isGoogleSignIn('https://api.singulancelabs.com.attacker.test/auth/google', 'https://runtime-runner.singulancelabs.com/'), false);
  assert.equal(isGoogleSignIn('https://api.singulancelabs.com/v1/connectors/gmail', 'https://runtime-runner.singulancelabs.com/'), false);
});

test('random loopback callback rejects mismatched state, duplicates and non-GET; consumes once', async t => {
  let startUrl, calls = 0, completed = 0;
  const service = createBrowserSignIn({ openExternal: async value => { startUrl = new URL(value); }, admit: async token => { assert.equal(token, 'fresh-session'); calls++; return {}; }, onComplete: async () => { completed++; }, onError: error => { throw error; } });
  t.after(service.cancel);
  await service.start('https://api.singulancelabs.com/auth/google?workspace_invite=fixture&return_to=https://evil.example');
  assert.equal(startUrl.searchParams.get('workspace_invite'), 'fixture');
  const cb = new URL(startUrl.searchParams.get('return_to'));
  assert.equal(cb.hostname, '127.0.0.1'); assert.equal(cb.searchParams.get('state').length, 64);
  const wrong = new URL(cb); wrong.searchParams.set('state', 'x'.repeat(64)); wrong.searchParams.set('token', 'fresh-session');
  assert.equal((await fetch(wrong)).status, 403); assert.equal(calls, 0);
  cb.searchParams.set('token', 'fresh-session');
  assert.equal((await fetch(cb, { method: 'POST' })).status, 403);
  assert.equal((await fetch(cb, { headers: { origin: 'https://evil.example' } })).status, 403);
  const badHost = await new Promise((resolve, reject) => { const request = require('node:http').get(cb, { headers: { host: 'evil.example' } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); });
  assert.equal(badHost, 403);
  const [first, second] = await Promise.all([fetch(cb, { redirect: 'manual' }), fetch(cb, { redirect: 'manual' })]);
  assert.deepEqual([first.status, second.status].sort(), [303, 409]); assert.equal(calls, 1); assert.equal(completed, 1);
  const success = await fetch(new URL('/complete', cb)); assert.equal(success.status, 200); assert.equal(success.headers.get('referrer-policy'), 'no-referrer');
  assert.equal((await success.text()).includes('fresh-session'), false);
});

test('timeout closes listener and never admits a late callback', async () => {
  let cb, error;
  const service = createBrowserSignIn({ openExternal: async url => { cb = new URL(url).searchParams.get('return_to'); }, admit: async () => { throw new Error('must not admit'); }, onComplete: async () => {}, onError: e => { error = e; }, timeoutMs: 30 });
  await service.start('https://api.singulancelabs.com/auth/google'); await delay(60);
  assert.match(error.message, /expired/); await assert.rejects(fetch(cb)); service.cancel();
});

test('validates session at fixed endpoint, never forwards old cookies; accepts only server cookie', async () => {
  let stored;
  const cookies = { set: async value => { stored = value; }, flushStore: async () => {} };
  const response = () => new Response(JSON.stringify({ authenticated: true, user: { id: 'user1' } }), { headers: { 'Set-Cookie': 'hm_cp_session=signed%3Avalue; HttpOnly; Path=/; SameSite=None; Secure; Domain=.singulancelabs.com; Max-Age=600' } });
  await admitSession('fresh', cookies, async (url, options) => {
    assert.equal(url, 'https://api.singulancelabs.com/auth/session'); assert.deepEqual(options.headers, { authorization: 'Bearer fresh' }); assert.equal(options.redirect, 'error'); return response();
  });
  assert.equal(stored.value, 'signed%3Avalue'); assert.equal(stored.httpOnly, true); assert.equal(stored.secure, true); assert.equal(stored.domain, '.singulancelabs.com');
  stored = undefined;
  await assert.rejects(admitSession('bad', cookies, async () => new Response('', { status: 401 }))); assert.equal(stored, undefined);
  await assert.rejects(admitSession('fresh', cookies, async () => response(), () => false)); assert.equal(stored, undefined);
  await assert.rejects(admitSession('fresh', cookies, async () => new Response(JSON.stringify({ authenticated: true, user: { id: 'user1' } }), { headers: { 'Set-Cookie': 'hm_cp_session=x; Domain=evil.example; HttpOnly; Secure; Path=/; Max-Age=600' } }))); assert.equal(stored, undefined);
});

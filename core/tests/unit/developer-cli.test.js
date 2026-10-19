import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { developerRequest, developerCredential, readDeveloperCredential, handleDeveloperCli } from '../../src/auth/developer-cli.js';
const origin = 'https://api.example.test';
const verifier = 'v'.repeat(43);
const callback = 'http://127.0.0.1:45678/callback';
const state = 's'.repeat(43);
const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
const start = new URL('/auth/developer/cli/start', origin);
start.search = new URLSearchParams({ callback, state, code_challenge: challenge, code_challenge_method: 'S256' });
function fixture() {
  const codes = new Map(); let active = true; let counter = 0;
  const response = { headers: {}, setHeader(k, v) { this.headers[k] = v; } };
  const deps = { origin, frontend: 'https://app.example.test', secret: 'test-secret',
    currentSession: async () => ({ sessionId: 'session', session: { userId: 'person' } }),
    sessionStore: { createAuthState: async (v) => { const code = `code-${++counter}`; codes.set(code, v); return code; }, consumeAuthState: async (k) => { const v = codes.get(k); codes.delete(k); return v; }, getSession: async () => active ? { userId: 'person' } : null },
    prisma: { user: { findUnique: async () => ({ id: 'person', email: 'dev@example.test' }) } },
    parseBody: async (req) => req.body,
    json: (res, body, status = 200) => { Object.assign(res, { body, status }); },
    redirect: (res, location) => { Object.assign(res, { location, status: 302 }); },
  };
  return { deps, codes, response, revoke: () => { active = false; } };
}
test('developer requests accept only canonical issuer, loopback, state and S256', () => {
  assert.ok(developerRequest(start, origin));
  for (const [key, value] of [['callback', 'https://evil.test/callback'], ['callback', 'http://127.0.0.1:123/callback?token=x'], ['callback', 'http://user@127.0.0.1:123/callback'], ['state', 'short'], ['code_challenge_method', 'plain']]) {
    const bad = new URL(start); bad.searchParams.set(key, value); assert.equal(developerRequest(bad, origin), null);
  }
  assert.equal(developerRequest(start.toString().replace('api.example', 'evil.example'), origin), null);
});
test('org-less person receives code; only terminal verifier redeems identity; replay and revocation denied', async () => {
  const f = fixture();
  await handleDeveloperCli({ ...f.deps, pathname: start.pathname, url: start, req: { method: 'GET' }, res: f.response });
  const target = new URL(f.response.location);
  assert.equal(target.searchParams.get('state'), state);
  assert.equal(target.searchParams.has('token'), false);
  const body = { code: target.searchParams.get('code'), callback, code_verifier: verifier };
  await handleDeveloperCli({ ...f.deps, pathname: '/auth/developer/cli/exchange', req: { method: 'POST', body }, res: f.response });
  assert.equal(f.response.body.accountType, 'developer'); assert.equal(f.response.body.orgId, null);
  assert.equal(f.response.body.scope, 'developer:identity');
  const token = f.response.body.token;
  const profile = () => handleDeveloperCli({ ...f.deps, pathname: '/auth/developer/me', req: { method: 'GET', headers: { authorization: `Bearer ${token}` } }, res: f.response });
  await profile(); assert.equal(f.response.status, 200);
  await handleDeveloperCli({ ...f.deps, pathname: '/auth/developer/cli/exchange', req: { method: 'POST', body }, res: f.response });
  assert.equal(f.response.status, 400);
  f.revoke(); await profile(); assert.equal(f.response.status, 401);
});
test('wrong verifier, wrong callback and expired code fail closed', async () => {
  for (const mutation of [b => { b.code_verifier = 'x'.repeat(43); }, b => { b.callback = 'http://127.0.0.1:9/callback'; }, () => {}]) {
    const f = fixture();
    await handleDeveloperCli({ ...f.deps, pathname: start.pathname, url: start, req: { method: 'GET' }, res: f.response });
    const code = new URL(f.response.location).searchParams.get('code');
    const body = { code, callback, code_verifier: verifier }; mutation(body);
    if (body.code_verifier === verifier && body.callback === callback) f.codes.get(code).expiresAt = 0;
    await handleDeveloperCli({ ...f.deps, pathname: '/auth/developer/cli/exchange', req: { method: 'POST', body }, res: f.response });
    assert.equal(f.response.status, 400);
  }
});
test('signed-out developer reaches existing branded login without a customer organization', async () => {
  const f = fixture(); f.deps.currentSession = async () => null;
  await handleDeveloperCli({ ...f.deps, pathname: start.pathname, url: start, req: { method: 'GET' }, res: f.response });
  const login = new URL(f.response.location);
  assert.equal(login.pathname, '/hivemind/login'); assert.equal(login.searchParams.get('account'), 'developer');
});
test('developer credentials reject tampering, wrong secret and expiration', () => {
  const token = developerCredential('secret', { userId: 'person' });
  assert.ok(readDeveloperCredential('secret', token));
  assert.equal(readDeveloperCredential('other', token), null);
  assert.equal(readDeveloperCredential('secret', token + 'x'), null);
  assert.equal(readDeveloperCredential('secret', 'customer-api-key'), null);
  const now = Date.now;
  try { Date.now = () => now() + 8 * 86400_000; assert.equal(readDeveloperCredential('secret', token), null); }
  finally { Date.now = now; }
});

// Execute the actual provider route bodies with external delivery/provider IO replaced.
// This catches wiring mistakes that isolated exchange tests cannot detect.
import fs from 'node:fs';
const source = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
async function route(from, to, deps) {
  const block = source.slice(source.indexOf(from), source.indexOf(to, source.indexOf(from) + from.length));
  return new AsyncFunction(...Object.keys(deps), block)(...Object.values(deps));
}
test('email enrollment uses verified developer return and skips company activation; customer admission remains required', async () => {
  let admitted = 0;
  for (const returnTo of [start.toString(), 'https://app.example.test/hivemind/app/overview']) {
    await route("  if (pathname === '/auth/email/start'", "  if (pathname === '/auth/email/resend'", {
      pathname: '/auth/email/start', req: { method: 'POST' }, res: {},
      effectiveEmailIdentityMode: async () => 'primary', parseBody: async () => ({ email: 'new@example.test', return_to: returnTo }),
      verifyEmailTurnstile: async () => true, safeReturnTo: v => v, emailPostLoginRedirect: '', emailAllowedOrigins: [],
      isDeveloperReturn: v => Boolean(developerRequest(v, origin)), normalizeEmail: v => v, emailSignupAdmission: () => null,
      prisma: { user: { findUnique: async () => null } }, emailDeliveryConfigured: () => true,
      emailIdentity: { start: async () => { admitted++; return {}; } }, emailRequestFingerprint: () => 'fixture',
      EMAIL_AUTH_PUBLIC_RESPONSE: {}, jsonResponse: () => {}, crypto, process, console, setTimeout: fn => { fn(); },
    });
  }
  assert.equal(admitted, 1);
  let sessionPayload;
  await route("  if (pathname === '/auth/email/verify'", '  // rollback.', {
    pathname: '/auth/email/verify', req: { method: 'POST' }, res: {},
    effectiveEmailIdentityMode: async () => 'primary', parseBody: async () => ({ challenge_id: 'fixture', code: '123456' }), isCanonicalUuid: () => true,
    emailIdentity: { verify: async () => ({ ok: true, email: 'new@example.test', challenge: { intent: 'login', returnTo: start.toString() } }), consume: async () => true },
    prisma: { user: { findUnique: async () => null } }, isDeveloperReturn: v => Boolean(developerRequest(v, origin)),
    upsertVerifiedEmailUser: async () => ({ id: 'person', email: 'new@example.test' }), resolveSessionOrg: () => assert.fail('developer must not resolve a tenant'),
    sessionStore: { createSession: async v => { sessionPayload = v; return 'session'; } },
    queueSignupAdminNotification: () => assert.fail('no customer signup notifications'), startSignupActivation: () => assert.fail('no company activation'),
    safeReturnTo: () => assert.fail('developer return already validated'), makeSessionCookie: () => 'cookie',
    jsonResponse: (_res, body) => { assert.equal(body.needs_onboarding, false); assert.equal(body.redirect_to, start.toString()); }, console,
  });
  assert.equal(sessionPayload.orgId, null);
});
test('Google developer enrollment reuses provider verification without selecting a customer tenant', async () => {
  let sessionPayload;
  await route("  if (pathname === '/auth/google/callback'", '  // ─── CLI browser-auth handshake', {
    pathname: '/auth/google/callback', req: { method: 'GET', headers: { host: 'api.example.test' } }, res: {},
    url: new URL('/auth/google/callback?code=provider-code&state=fixture', origin),
    sessionStore: { consumeAuthState: async () => ({ developerAccount: true, returnTo: start.toString() }), createSession: async v => { sessionPayload = v; return 'session'; } },
    fetch: async target => ({ ok: true, json: async () => target.includes('/token') ? { access_token: 'provider-secret' } : { id: 'google-person', email: 'dev@example.test', verified_email: true } }),
    normalizeEmail: v => v, platformUserExists: async () => false, upsertUserFromZitadel: async () => ({ id: 'person', email: 'dev@example.test' }),
    resolveCurrentOrg: () => assert.fail('developer must not resolve a tenant'), queueSignupAdminNotification: () => assert.fail('no customer signup notification'),
    isDeveloperReturn: v => Boolean(developerRequest(v, origin)), makeSessionCookie: () => 'cookie',
    redirect: (_res, target) => { assert.equal(target, start.toString()); }, jsonResponse: () => assert.fail('unexpected failure'),
    CONFIG: {}, process: { env: { GOOGLE_CLIENT_ID: 'fixture', GOOGLE_CLIENT_SECRET: 'fixture' } }, console: { log() {}, error: (...v) => assert.fail(v.join(' ')) }, URLSearchParams,
  });
  assert.equal(sessionPayload.orgId, null);
});

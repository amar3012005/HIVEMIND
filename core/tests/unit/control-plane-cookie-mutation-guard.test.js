import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { evaluateCookieMutation, hasCookie, trustedOriginSet } from '../../src/control-plane/cookie-mutation-guard.js';

const trustedOrigins = trustedOriginSet(['https://next.singulancelabs.com', 'https://api.singulancelabs.com/', 'not a url']);
const base = {
  cookieName: 'hm_cp_session',
  trustedOrigins,
  multipartPathPrefixes: ['/v1/proxy/', '/v1/campaigns'],
};
const cookie = 'theme=dark; hm_cp_session=signed.value';
const run = (method, pathname, headers) => evaluateCookieMutation({ ...base, method, pathname, headers });

test('a cross-site POST carrying the session cookie is rejected', () => {
  assert.deepEqual(
    run('POST', '/v1/connectors/composio/gmail/disconnect', { cookie, origin: 'https://evil.example' }),
    { allowed: false, status: 403, error: 'cross_site_request_blocked' },
  );
  assert.equal(run('POST', '/v1/proxy/memories', { cookie, origin: 'null' }).allowed, false);
  assert.equal(run('DELETE', '/v1/proxy/memories/1', { cookie, 'sec-fetch-site': 'cross-site' }).allowed, false);
  assert.equal(run('PUT', '/v1/proxy/memories/1', { cookie, 'sec-fetch-site': 'same-site' }).allowed, false);
});

test('simple-request body types are rejected even from a trusted origin', () => {
  const origin = 'https://next.singulancelabs.com';
  assert.deepEqual(
    run('POST', '/v1/proxy/memories', { cookie, origin, 'content-type': 'text/plain;charset=UTF-8' }),
    { allowed: false, status: 415, error: 'json_content_type_required' },
  );
  assert.equal(run('POST', '/v1/proxy/memories', { cookie, origin, 'content-type': 'application/x-www-form-urlencoded' }).allowed, false);
  assert.equal(run('POST', '/v1/connectors/composio/gmail/connect', { cookie, origin, 'content-type': 'multipart/form-data; boundary=x' }).allowed, false);
});

test('trusted first-party requests proceed', () => {
  const origin = 'https://next.singulancelabs.com';
  assert.equal(run('POST', '/v1/proxy/memories', { cookie, origin, 'content-type': 'application/json' }).allowed, true);
  assert.equal(run('POST', '/v1/connectors/composio/gmail/disconnect', { cookie, origin }).allowed, true);
  assert.equal(run('POST', '/v1/proxy/knowledge/upload', { cookie, origin, 'content-type': 'multipart/form-data; boundary=x' }).allowed, true);
  assert.equal(run('POST', '/v1/campaigns/1/actions/2/assets/upload', { cookie, origin, 'content-type': 'multipart/form-data; boundary=x' }).allowed, true);
  assert.equal(run('POST', '/v1/proxy/memories', { cookie, origin: 'https://api.singulancelabs.com', 'content-type': 'application/json' }).allowed, true);
  assert.equal(run('POST', '/v1/proxy/memories', { cookie, 'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }).allowed, true);
});

test('requests outside ambient-cookie authentication are not affected', () => {
  assert.equal(run('GET', '/v1/proxy/memories', { cookie, origin: 'https://evil.example' }).allowed, true);
  assert.equal(run('POST', '/v1/webhooks/stripe', { origin: 'https://evil.example', 'content-type': 'text/plain' }).allowed, true);
  assert.equal(run('POST', '/v1/proxy/memories', { cookie, authorization: 'Bearer token', origin: 'https://evil.example' }).allowed, true);
  assert.equal(run('POST', '/v1/proxy/memories', { cookie, 'content-type': 'application/json' }).allowed, true);
  assert.equal(run('POST', '/v1/proxy/memories', { cookie: 'hm_cp_session=', origin: 'https://evil.example' }).allowed, true);
});

test('cookie detection matches the exact cookie name', () => {
  assert.equal(hasCookie('xhm_cp_session=1', 'hm_cp_session'), false);
  assert.equal(hasCookie('a=1; hm_cp_session=2', 'hm_cp_session'), true);
  assert.equal(hasCookie(undefined, 'hm_cp_session'), false);
});

test('the Control Plane applies the guard before any route handler', () => {
  const server = fs.readFileSync(new URL('../../src/control-plane-server.js', import.meta.url), 'utf8');
  const handler = server.slice(server.indexOf('const server = http.createServer(async (req, res) => {'));
  const guard = handler.indexOf('evaluateCookieMutation({');
  assert.ok(guard > 0);
  assert.ok(guard < handler.indexOf('handleMobileAuthRoutes({'));
  assert.ok(guard < handler.indexOf("pathname.startsWith('/v1/proxy/')"));
  assert.match(server, /COOKIE_MUTATION_MULTIPART_PREFIXES = \['\/v1\/proxy\/', '\/v1\/campaigns'\]/);
});

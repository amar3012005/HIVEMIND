'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const p = require('../src/native/policy');

test('request allowlist accepts Core and Runner paths', () => {
  assert.equal(p.classifyRequest('https://api.singulancelabs.com/v1/me').kind, 'core');
  assert.equal(p.classifyRequest('https://api.singulancelabs.com/auth/mobile/token', 'POST').kind, 'core');
  assert.equal(p.classifyRequest('https://next.singulancelabs.com/api/x', 'POST').kind, 'runner');
  assert.equal(p.classifyRequest('https://next.singulancelabs.com/assets/a.js').kind, 'runner');
});

test('request allowlist rejects everything else', () => {
  const bad = [
    'http://api.singulancelabs.com/v1/me', 'https://evil.com/v1/me', 'https://api.singulancelabs.com.evil.com/v1/x',
    'https://user:pw@api.singulancelabs.com/v1/x', 'https://api.singulancelabs.com:8443/v1/x', 'https://api.singulancelabs.com/v1/x#f',
    'https://api.singulancelabs.com/v1/%2e%2e/admin', 'https://api.singulancelabs.com/v1/..%2fadmin', 'https://api.singulancelabs.com/v1/../admin',
    'https://api.singulancelabs.com/admin', 'https://next.singulancelabs.com/hivemind/app', 'file:///etc/passwd', 'https://singulancelabs.com/v1/x',
  ];
  for (const u of bad) assert.throws(() => p.classifyRequest(u), u);
  assert.throws(() => p.classifyRequest('https://next.singulancelabs.com/assets/a', 'POST'));
  assert.throws(() => p.classifyRequest('https://api.singulancelabs.com/v1/x', 'TRACE'));
});

test('caller headers are limited to Accept and Content-Type', () => {
  assert.deepEqual(p.filterCallerHeaders({ Accept: 'a', 'Content-Type': 'b', Authorization: 'x', Cookie: 'y', Origin: 'z', Host: 'h' }), { accept: 'a', 'content-type': 'b' });
  assert.deepEqual(p.filterCallerHeaders({ Accept: 'a\r\nX: 1' }), {});
});

test('room path and navigation', () => {
  const id = '0f8fad5b-d9cb-469f-a165-70867728950e';
  assert.equal(p.roomUrl(`/employees/${id}`), `https://runtime-runner.singulancelabs.com/employees/${id}?embed=hivemind`);
  for (const bad of ['/employees/x', `/employees/${id}/../x`, `//evil.com/employees/${id}`, `/other/${id}`, 5, null]) assert.throws(() => p.roomUrl(bad));
  assert.ok(p.isRoomNavigationAllowed('https://dots.singulancelabs.com/a'));
  assert.ok(!p.isRoomNavigationAllowed('https://singulancelabs.com/'));
  assert.ok(!p.isRoomNavigationAllowed('http://dots.singulancelabs.com/'));
  assert.ok(!p.isRoomNavigationAllowed('https://dots.singulancelabs.com.evil.com/'));
});

test('sender trust, deep links, app paths, session cookie', () => {
  assert.ok(p.isTrustedSender('https://next.singulancelabs.com/hivemind/app'));
  assert.ok(p.isTrustedSender('file:///app/src/offline.html'));
  assert.ok(!p.isTrustedSender('https://evilsingulancelabs.com/'));
  assert.ok(!p.isTrustedSender('file:///etc/x.html'));
  assert.ok(p.parseDeepLink('singulance://auth/callback?code=1'));
  assert.equal(p.parseDeepLink('https://x.com'), null);
  assert.equal(p.parseDeepLink('singulance://u:p@x'), null);
  assert.equal(p.safeAppPath('/hivemind/app/bell'), '/hivemind/app/bell');
  assert.equal(p.safeAppPath('//evil.com'), null);
  assert.equal(p.safeAppPath('https://evil.com'), null);
  assert.deepEqual(p.parseSessionCookie(['x=1', 'hm_cp_session=abc=; Domain=.singulancelabs.com; Secure; HttpOnly']), { name: 'hm_cp_session', value: 'abc=', domain: 'singulancelabs.com' });
  assert.equal(p.parseSessionCookie(['hm_cp_session=abc; Path=/']), null);
  assert.equal(p.parseSessionCookie(['hm_cp_session=abc; Domain=evil.com; Secure']).domain, null);
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { classifyScreenRequest: classify } = require('../src/native/screens-policy');
const { ScreensStore } = require('../src/native/screens-store');
const { createScreensHandler } = require('../src/native/screens-handler');
const { createUpdater, parseManifest } = require('../src/native/screens-updater');
const { createScreens } = require('../src/native/screens');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'scr-'));
const ROOM = 'runtime-runner.singulancelabs.com';
const DOC = { accept: 'text/html,application/xhtml+xml', 'sec-fetch-dest': 'document' };
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const req = (url, init = {}) => new Request(url, init);
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('allowlist: hashed assets and app/room shells only on the three hosts', () => {
  assert.equal(classify({ url: `https://${ROOM}/assets/index-BxK3a9Zq.js` }).kind, 'asset');
  assert.equal(classify({ url: 'https://dots.singulancelabs.com/static/js/main.a1b2c3d4.js' }).kind, 'asset');
  assert.equal(classify({ url: 'https://singulancelabs.com/hivemind/static/css/main.0a1b2c3d.css' }).kind, 'asset');
  assert.equal(classify({ url: `https://${ROOM}/employees/123`, headers: DOC }).kind, 'shell');
  assert.equal(classify({ url: 'https://singulancelabs.com/hivemind/app/overview', headers: DOC }).kind, 'shell');
  assert.equal(classify({ url: 'https://dots.singulancelabs.com/dots/abc', headers: DOC }).kind, 'pass');
  assert.equal(classify({ url: 'https://singulancelabs.com/pricing', headers: DOC }).kind, 'pass');
  assert.equal(classify({ url: 'https://evil.com/assets/index-BxK3a9Zq.js' }).kind, 'pass');
  assert.equal(classify({ url: 'https://api.singulancelabs.com/assets/index-BxK3a9Zq.js' }).kind, 'pass');
  assert.equal(classify({ url: 'http://singulancelabs.com/assets/index-BxK3a9Zq.js' }).kind, 'pass');
  assert.equal(classify({ url: `https://${ROOM}:8443/assets/index-BxK3a9Zq.js` }).kind, 'pass');
  assert.notEqual(classify({ url: `https://${ROOM}/assets/../secret-a1b2c3d4e5.js` }).kind, 'asset'); // URL parsing already collapsed the dots
  assert.notEqual(classify({ url: `https://${ROOM}/assets/%2e%2e/x-a1b2c3d4e5.js` }).kind, 'asset');
  // a plain name without a hash is not an immutable asset
  assert.equal(classify({ url: `https://${ROOM}/assets/longname.js` }).kind, 'bundle');
  // fetch()/XHR without a document Accept never gets the shell
  assert.equal(classify({ url: `https://${ROOM}/employees/123`, headers: { accept: '*/*' } }).kind, 'pass');
});

test('API, auth, streams, uploads and ranges are never intercepted', () => {
  for (const p of ['/api/employees', '/auth/session', '/v1/x', '/stream', '/events', '/ws', '/upload', '/uploads/a-1b2c3d4e5f.png',
    '/hivemind/app/api/x', '/assets/api/index-BxK3a9Zq.js', '/oauth/callback', '/__hivemind/account-mode-access']) {
    assert.equal(classify({ url: `https://${ROOM}${p}`, headers: DOC }).kind, 'pass', p);
  }
  assert.equal(classify({ url: `https://${ROOM}/assets/index-BxK3a9Zq.js`, headers: { range: 'bytes=0-9' } }).kind, 'pass');
  assert.equal(classify({ url: `https://${ROOM}/assets/index-BxK3a9Zq.js`, headers: { authorization: 'Bearer x' } }).kind, 'pass');
  assert.equal(classify({ url: `https://${ROOM}/ui-manifest.json` }).kind, 'pass');
});

test('non-GET requests always pass through, even for hashed asset URLs', () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']) {
    assert.equal(classify({ url: `https://${ROOM}/assets/index-BxK3a9Zq.js`, method }).kind, 'pass', method);
  }
});

function setup(netBody = 'net-body') {
  const store = new ScreensStore({ root: tmp() });
  const calls = [];
  const passthrough = async (r) => { calls.push(`${r.method} ${r.url}`); return new Response(netBody, { status: 200, headers: { 'content-type': 'text/javascript' } }); };
  return { store, calls, handle: createScreensHandler({ store, passthrough }) };
}

test('handler: non-GET and API go to the network and are never stored', async () => {
  const { store, calls, handle } = setup();
  await handle(req(`https://${ROOM}/api/x`));
  await handle(req(`https://${ROOM}/assets/index-BxK3a9Zq.js`, { method: 'POST', body: 'a' }));
  await handle(req('https://evil.com/assets/index-BxK3a9Zq.js'));
  await wait();
  assert.equal(calls.length, 3);
  assert.equal(store.read(ROOM, 'assets/index-BxK3a9Zq.js'), null);
  assert.equal(store.read(ROOM, 'api/x'), null);
  assert.ok(!fs.existsSync(path.join(store.root, ROOM, '_cache')));
});

test('handler: hashed asset is stored from the network once, then served locally', async () => {
  const { calls, handle } = setup('console.log(1)');
  const url = `https://${ROOM}/assets/index-BxK3a9Zq.js`;
  const a = await handle(req(url));
  assert.equal(await a.text(), 'console.log(1)');
  await wait();
  const b = await handle(req(url));
  assert.equal(await b.text(), 'console.log(1)');
  assert.equal(b.headers.get('x-singulance-screens'), 'cache');
  assert.match(b.headers.get('content-type'), /javascript/);
  assert.equal(calls.length, 1);
});

test('handler: an HTML fallback for a missing asset is not stored', async () => {
  const store = new ScreensStore({ root: tmp() });
  const handle = createScreensHandler({ store, passthrough: async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }) });
  await handle(req(`https://${ROOM}/assets/index-BxK3a9Zq.js`));
  await wait();
  assert.equal(store.read(ROOM, 'assets/index-BxK3a9Zq.js'), null);
});

test('handler: shell comes from the active bundle only when one exists', async () => {
  const { store, calls, handle } = setup();
  const url = `https://${ROOM}/employees/1`;
  await handle(req(url, { headers: DOC }));
  assert.equal(calls.length, 1);
  const v = store.beginVersion(ROOM, 'v1', 'index.html'); v.write('index.html', '<html>local</html>'); v.commit();
  store.activate();
  const r = await handle(req(url, { headers: DOC }));
  assert.equal(await r.text(), '<html>local</html>');
  assert.equal(calls.length, 1);
  const api = await handle(req(`https://${ROOM}/api/x`, { headers: DOC }));
  assert.equal(await api.text(), 'net-body');
});

const manifestFetch = (manifest, files, log = []) => async (url) => {
  log.push(url);
  const u = new URL(url);
  if (u.pathname === '/ui-manifest.json') return manifest ? new Response(JSON.stringify(manifest), { status: 200 }) : new Response('nf', { status: 404 });
  const body = files[u.pathname.slice(1)];
  return body == null ? new Response('nf', { status: 404 }) : new Response(body, { status: 200 });
};

test('updater: tolerates 404, offline and invalid manifests', async () => {
  const store = new ScreensStore({ root: tmp() });
  assert.equal((await createUpdater({ store, fetch: manifestFetch(null, {}) }).checkHost(ROOM)).status, 'none');
  assert.equal((await createUpdater({ store, fetch: async () => { throw new Error('offline'); } }).checkHost(ROOM)).status, 'offline');
  assert.equal((await createUpdater({ store, fetch: manifestFetch({ version: '../x', files: [] }, {}) }).checkHost(ROOM)).status, 'invalid');
  assert.equal(parseManifest(JSON.stringify({ version: 'v1', files: ['../etc/passwd'] })), null);
  assert.equal(parseManifest(JSON.stringify({ version: 'v1', files: [{ path: 'a.js', sha256: 'zz' }] })), null);
});

test('updater: downloads missing files, verifies size and hash, switches on next activate, keeps two versions', async () => {
  const store = new ScreensStore({ root: tmp() });
  const files = { 'index.html': '<html>1</html>', 'assets/app-Ab12Cd34.js': 'js1' };
  const m = (version, f) => ({ version, shell: 'index.html', files: Object.entries(f).map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b) })) });
  const up = (manifest, f) => createUpdater({ store, fetch: manifestFetch(manifest, f) });

  assert.equal((await up(m('v1', files), files).checkHost(ROOM)).status, 'downloaded');
  assert.equal(store.read(ROOM, 'assets/app-Ab12Cd34.js'), null, 'not active until the next window');
  store.activate();
  assert.equal(store.read(ROOM, 'assets/app-Ab12Cd34.js').data.toString(), 'js1');
  assert.equal(store.readShell(ROOM).data.toString(), '<html>1</html>');
  assert.equal((await up(m('v1', files), files).checkHost(ROOM)).status, 'current');

  const f2 = { 'index.html': '<html>2</html>', 'assets/app-Ef56Gh78.js': 'js2' };
  assert.equal((await up(m('v2', f2), f2).checkHost(ROOM)).status, 'downloaded');
  assert.equal(store.readShell(ROOM).data.toString(), '<html>1</html>', 'running windows keep v1');
  store.activate();
  assert.equal(store.readShell(ROOM).data.toString(), '<html>2</html>');

  const f3 = { 'index.html': '<html>3</html>' };
  await up(m('v3', f3), f3).checkHost(ROOM);
  assert.deepEqual(store.versions(ROOM).map((v) => v.version).sort(), ['v2', 'v3'].sort(), 'only the last two complete versions remain (active v2 kept)');
  assert.ok(!fs.existsSync(path.join(store.root, ROOM, 'v1')));
});

test('updater: a hash or size mismatch leaves no version behind', async () => {
  const store = new ScreensStore({ root: tmp() });
  const bad = { version: 'v9', files: [{ path: 'assets/app-Ab12Cd34.js', sha256: sha('expected') }] };
  const r = await createUpdater({ store, fetch: manifestFetch(bad, { 'assets/app-Ab12Cd34.js': 'tampered' }) }).checkHost(ROOM);
  assert.equal(r.status, 'failed');
  assert.deepEqual(store.versions(ROOM), []);
  const hostDir = path.join(store.root, ROOM);
  assert.deepEqual(fs.readdirSync(hostDir).filter((n) => n.startsWith('.tmp-')), []);
  const bad2 = { version: 'v9', files: [{ path: 'a.js', size: 99 }] };
  assert.equal((await createUpdater({ store, fetch: manifestFetch(bad2, { 'a.js': 'x' }) }).checkHost(ROOM)).status, 'failed');
});

test('store: refuses hosts off the allowlist and traversal', () => {
  const store = new ScreensStore({ root: tmp() });
  assert.throws(() => store.read('evil.com', 'a.js'));
  assert.throws(() => store.beginVersion(ROOM, '../x'));
  assert.equal(store.writeCache(ROOM, '../escape.js', 'x'), false);
});

test('clear (sign-out) removes every stored screen', async () => {
  const dir = tmp();
  const fakeSession = { protocol: { handle: () => {} }, fetch: async () => new Response('') };
  const screens = createScreens({ electron: { net: { fetch: async () => new Response('', { status: 404 }) } }, userDataDir: dir, enabled: true });
  screens.store.writeCache(ROOM, 'assets/x-Ab12Cd34.js', 'x');
  const v = screens.store.beginVersion(ROOM, 'v1', 'index.html'); v.write('index.html', 'x'); v.commit();
  assert.equal(screens.install(fakeSession), true);
  screens.clear();
  screens.stop();
  assert.ok(!fs.existsSync(path.join(dir, 'screens', ROOM, 'v1')));
  assert.equal(screens.store.read(ROOM, 'assets/x-Ab12Cd34.js'), null);
});

test('disabled switch installs nothing', () => {
  const screens = createScreens({ electron: { net: {} }, userDataDir: tmp(), enabled: false });
  assert.equal(screens.install({ protocol: { handle: () => { throw new Error('should not be called'); } } }), false);
});

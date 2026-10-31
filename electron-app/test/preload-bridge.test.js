'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { CHANNELS, createBridge, registerBridge } = require('../src/native/bridge');
const { TokenStore } = require('../src/native/token-store');

function loadPreload() {
  const exposed = {}; const invoked = []; const listened = [];
  const fake = {
    contextBridge: { exposeInMainWorld: (n, v) => { exposed[n] = v; } },
    ipcRenderer: { invoke: (c, a) => { invoked.push([c, a]); return Promise.resolve({ value: null }); }, on: (c) => listened.push(c), removeListener() {} },
  };
  const orig = Module._load;
  Module._load = (req, ...r) => (req === 'electron' ? fake : orig(req, ...r));
  try { delete require.cache[require.resolve('../src/preload.js')]; require('../src/preload.js'); } finally { Module._load = orig; }
  return { exposed, invoked, listened };
}

test('every channel the preload invokes is registered in the main bridge', async () => {
  const { exposed, invoked } = loadPreload();
  const api = exposed.singulanceDesktop;
  await api.tokenStore.get('cpToken'); await api.tokenStore.set('cpToken', 'x'); await api.tokenStore.remove('cpToken');
  await api.prefs.get('k'); await api.prefs.set('k', 'v');
  await api.request({}); await api.workspaceAccess(); await api.openRoom({}); await api.prewarmRoom({}); await api.closeRoom({});
  await api.notify({}); await api.setUnread(1);
  await api.setNotificationPrefs({}); await api.setTrayStatus({}); await api.getLoginItem(); await api.setLoginItem(true);
  assert.equal(api.haptic('success'), undefined);
  for (const [c] of invoked) assert.ok(CHANNELS.includes(c), c);
  assert.equal(new Set(invoked.map(([c]) => c)).size, CHANNELS.length, 'every registered channel is reachable');
});

test('preload exposes no raw ipcRenderer, require or process', () => {
  const { exposed } = loadPreload();
  const api = exposed.singulanceDesktop;
  assert.ok(Object.isFrozen(api));
  for (const k of ['ipcRenderer', 'require', 'process', 'send', 'invoke']) assert.ok(!(k in api));
  assert.deepEqual(Object.keys(api).sort(), ['closeRoom', 'getLoginItem', 'haptic', 'notify', 'onForeground', 'onNotificationAction', 'onNotificationClick', 'onRoomClosed', 'openRoom', 'platform', 'prefs', 'prewarmRoom', 'request', 'setLoginItem', 'setNotificationPrefs', 'setTrayStatus', 'setUnread', 'tokenStore', 'version', 'workspaceAccess']);
});

test('tokenStore only accepts credential keys through the bridge', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-'));
  const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const b = createBridge({ tokenStore: new TokenStore({ safeStorage: safe, dir }), fetchCore: async () => {}, fetchRunner: async () => {}, prefsFile: path.join(dir, 'p.json'), setUnread() {}, rooms: {}, notifier: {} });
  await assert.rejects(async () => b.handlers['native:token:set']({ key: 'evil', value: 'x' }));
  await assert.rejects(async () => b.handlers['native:prefs:set']({ key: '../x', value: 'y' }));
  b.handlers['native:prefs:set']({ key: 'dial', value: '3' });
  assert.deepEqual(b.handlers['native:prefs:get']({ key: 'dial' }), { value: '3' });
});

function makeBridge(fetchCore, fetchRunner, token = 'T0K') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rq-'));
  const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const ts = new TokenStore({ safeStorage: safe, dir });
  if (token) ts.set('cpToken', token);
  return createBridge({ tokenStore: ts, fetchCore, fetchRunner, prefsFile: path.join(dir, 'p.json'), setUnread() {}, rooms: {}, notifier: {} });
}
const resp = (body, status = 200, headers = {}) => new Response(body, { status, headers });

test('request bridge injects bearer only for Core, strips caller auth, never follows redirects', async () => {
  let seen;
  const b = makeBridge(async (url, init) => { seen = { url, init }; return resp('{"ok":1}', 200, { 'content-type': 'application/json', 'set-cookie': 'a=b', 'x-secret': '1' }); }, async () => { throw new Error('no'); });
  const r = await b.handlers['native:request']({ url: 'https://api.singulancelabs.com/v1/me', authorize: true, headers: { Authorization: 'Bearer evil', Cookie: 'x', Accept: 'application/json' } });
  assert.equal(seen.init.headers.authorization, 'Bearer T0K');
  assert.equal(seen.init.headers.cookie, undefined);
  assert.equal(seen.init.redirect, 'manual');
  assert.deepEqual(Object.keys(r.headers), ['content-type']);
  assert.equal(r.data, '{"ok":1}');
  await assert.rejects(b.handlers['native:request']({ url: 'https://next.singulancelabs.com/api/x', authorize: true }));
});

test('signed-out authorize returns 401 without calling the network; runner gets Origin', async () => {
  let called = 0; let runnerInit;
  const b = makeBridge(async () => { called++; return resp(''); }, async (u, init) => { runnerInit = init; return resp('x'); }, null);
  const r = await b.handlers['native:request']({ url: 'https://api.singulancelabs.com/v1/me', authorize: true });
  assert.equal(r.status, 401); assert.equal(called, 0);
  await b.handlers['native:request']({ url: 'https://next.singulancelabs.com/api/a', method: 'POST', body: 'hi' });
  assert.equal(runnerInit.headers.origin, 'https://next.singulancelabs.com');
});

test('size caps and signing out aborts in-flight requests', async () => {
  const b = makeBridge(async (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('aborted')))), async () => resp(Buffer.alloc(21 * 1024 * 1024)));
  await assert.rejects(b.handlers['native:request']({ url: 'https://next.singulancelabs.com/api/big' }), /too large/);
  await assert.rejects(b.handlers['native:request']({ url: 'https://next.singulancelabs.com/api/a', method: 'POST', body: Buffer.alloc(9 * 1024 * 1024).toString('base64'), bodyEncoding: 'base64' }), /too large/);
  const pending = b.handlers['native:request']({ url: 'https://api.singulancelabs.com/v1/slow' });
  await new Promise((r) => setImmediate(r));
  await b.handlers['native:token:remove']({ key: 'cpToken' });
  await assert.rejects(pending, /aborted/);
});

test('ipc registration rejects subframes and foreign senders', async () => {
  const handlers = {};
  registerBridge({ removeHandler() {}, handle: (c, f) => { handlers[c] = f; } }, { handlers: Object.fromEntries(CHANNELS.map((c) => [c, () => 'ok'])) });
  const main = { url: 'https://next.singulancelabs.com/x' };
  assert.equal(handlers['native:unread']({ senderFrame: main, sender: { mainFrame: main } }, {}), 'ok');
  const sub = { url: 'https://next.singulancelabs.com/x' };
  assert.throws(() => handlers['native:unread']({ senderFrame: sub, sender: { mainFrame: main } }, {}), /untrusted/);
  const evil = { url: 'https://evil.com/' };
  assert.throws(() => handlers['native:token:get']({ senderFrame: evil, sender: { mainFrame: evil } }, {}), /untrusted/);
});

// ── Control session cookie cache and room channels ──
function roomBridge({ clock, fetchCore, rooms, lastRoom, token = 'T0K' }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rc-'));
  const safe = { isEncryptionAvailable: () => true, encryptString: (s) => Buffer.from(s), decryptString: (b) => b.toString() };
  const ts = new TokenStore({ safeStorage: safe, dir }); if (token) ts.set('cpToken', token);
  return createBridge({ tokenStore: ts, fetchCore, fetchRunner: async () => {}, prefsFile: path.join(dir, 'p.json'), setUnread() {}, rooms, notifier: {}, lastRoom, now: () => clock.t });
}
const P1 = '/employees/11111111-1111-1111-1111-111111111111';
const sessionResp = (extra = '') => ({ status: 200, headers: { getSetCookie: () => [`hm_cp_session=abc; Secure; HttpOnly${extra}`] } });

test('session cookie is fetched once and reused for 10 minutes, then fetched again', async () => {
  const clock = { t: 1_000_000 }; let fetches = 0; const opened = [];
  const rooms = { open: async (a) => { opened.push(await a.getCookie()); }, prewarm: async () => {}, close() {} };
  const b = roomBridge({ clock, rooms, fetchCore: async () => { fetches++; return sessionResp(); } });
  await b.handlers['native:room:open']({ path: P1 });
  await b.handlers['native:room:open']({ path: P1 });
  clock.t += 9 * 60_000;
  await b.handlers['native:room:open']({ path: P1 });
  assert.equal(fetches, 1);
  clock.t += 2 * 60_000; // 11 minutes in
  await b.handlers['native:room:open']({ path: P1 });
  assert.equal(fetches, 2);
  assert.equal(opened.length, 4); assert.equal(opened[0].value, 'abc');
});

test('cookie cache honours a shorter Max-Age and is dropped on token change and sign-out', async () => {
  const clock = { t: 0 }; let fetches = 0;
  const rooms = { open: async (a) => { await a.getCookie(); }, prewarm: async () => {}, close() {} };
  const b = roomBridge({ clock, rooms, fetchCore: async () => { fetches++; return sessionResp('; Max-Age=180'); } });
  await b.handlers['native:room:open']({ path: P1 });
  clock.t += 100_000; await b.handlers['native:room:open']({ path: P1 });
  assert.equal(fetches, 1, 'still valid 100 s in (180 s minus 60 s margin)');
  clock.t += 30_000; await b.handlers['native:room:open']({ path: P1 });
  assert.equal(fetches, 2, 'expired at 120 s');
  b.handlers['native:token:set']({ key: 'cpToken', value: 'OTHER' });
  await b.handlers['native:room:open']({ path: P1 });
  assert.equal(fetches, 3, 'new token, new session');
  await b.handlers['native:token:remove']({ key: 'cpToken' });
  let got; const r2 = { open: async (a) => { got = await a.getCookie(); }, prewarm: async () => {}, close() {} };
  const b2 = roomBridge({ clock, rooms: r2, fetchCore: async () => sessionResp(), token: null });
  await b2.handlers['native:room:open']({ path: P1 });
  assert.equal(got, null, 'signed out gives no cookie');
});

test('room close passes the path and is silent; invalid path rejected; prewarm uses the last room', async () => {
  const clock = { t: 0 }; const closes = []; const prewarms = [];
  const rooms = { open: async () => {}, prewarm: async (a) => { prewarms.push([a.path, a.scope]); }, close: (a) => closes.push(a) };
  const b = roomBridge({ clock, rooms, fetchCore: async () => sessionResp(), lastRoom: { get: () => ({ path: P1, scope: 's' }) } });
  b.handlers['native:room:close']({ path: P1 });
  assert.deepEqual(closes, [{ path: P1, silent: true }]);
  assert.throws(() => b.handlers['native:room:close']({ path: '/evil' }), /room/);
  await b.prewarmLastRoom();
  assert.deepEqual(prewarms, [[P1, 's']]);
});

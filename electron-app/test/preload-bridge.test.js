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
  await api.request({}); await api.workspaceAccess(); await api.openRoom({}); await api.closeRoom();
  await api.notify({}); await api.setUnread(1);
  for (const [c] of invoked) assert.ok(CHANNELS.includes(c), c);
  assert.equal(new Set(invoked.map(([c]) => c)).size, CHANNELS.length, 'every registered channel is reachable');
});

test('preload exposes no raw ipcRenderer, require or process', () => {
  const { exposed } = loadPreload();
  const api = exposed.singulanceDesktop;
  assert.ok(Object.isFrozen(api));
  for (const k of ['ipcRenderer', 'require', 'process', 'send', 'invoke']) assert.ok(!(k in api));
  assert.deepEqual(Object.keys(api).sort(), ['closeRoom', 'notify', 'onForeground', 'onNotificationClick', 'onRoomClosed', 'openRoom', 'platform', 'prefs', 'request', 'setUnread', 'tokenStore', 'version', 'workspaceAccess']);
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

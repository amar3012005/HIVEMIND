'use strict';
// Main-process side of the desktop PlatformAdapter. Each handler validates its own
// arguments; registerBridge additionally refuses senders that are not the top frame
// of a first-party page. Electron objects are injected so handlers are unit-testable.
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const policy = require('./policy');

const CHANNELS = Object.freeze([
  'native:token:get', 'native:token:set', 'native:token:remove',
  'native:prefs:get', 'native:prefs:set',
  'native:request', 'native:workspace-access',
  'native:room:open', 'native:room:close',
  'native:notify', 'native:unread',
]);

function createBridge(deps) {
  const { tokenStore, fetchCore, fetchRunner, rooms, notifier, setUnread, prefsFile, fs = nodeFs, onSignOut = () => {} } = deps;
  const controllers = new Set();

  const readPrefs = () => { try { return JSON.parse(fs.readFileSync(prefsFile, 'utf8')); } catch { return {}; } };
  const writePrefs = (obj) => {
    fs.mkdirSync(nodePath.dirname(prefsFile), { recursive: true });
    fs.writeFileSync(`${prefsFile}.tmp`, JSON.stringify(obj), { mode: 0o600 });
    fs.renameSync(`${prefsFile}.tmp`, prefsFile);
  };

  async function readCapped(response) {
    const declared = Number(response.headers.get('content-length'));
    if (declared > policy.MAX_RESPONSE_BODY) throw new Error('response too large');
    if (!response.body) return Buffer.alloc(0);
    const chunks = []; let total = 0;
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > policy.MAX_RESPONSE_BODY) throw new Error('response too large');
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }

  async function request(opts = {}) {
    const method = opts.method || 'GET';
    const { kind, url } = policy.classifyRequest(opts.url, method);
    const headers = policy.filterCallerHeaders(opts.headers);
    let body;
    if (opts.body != null) {
      if (method === 'GET' || method === 'HEAD') throw new Error('body');
      const enc = opts.bodyEncoding || 'utf8';
      if (enc !== 'utf8' && enc !== 'base64') throw new Error('encoding');
      if (typeof opts.body !== 'string' || opts.body.length > policy.MAX_REQUEST_BODY * 2) throw new Error('body');
      body = Buffer.from(opts.body, enc === 'base64' ? 'base64' : 'utf8');
      if (body.length > policy.MAX_REQUEST_BODY) throw new Error('body too large');
    }
    const responseType = opts.responseType || 'text';
    if (responseType !== 'text' && responseType !== 'base64') throw new Error('responseType');
    if (opts.authorize) {
      if (kind !== 'core') throw new Error('authorize');
      const token = tokenStore.get('cpToken');
      if (!token) return { status: 401, headers: {}, data: 'signed_out', encoding: 'text' };
      headers.authorization = `Bearer ${token}`;
    }
    if (kind === 'runner') headers.origin = `https://${policy.RUNNER_HOST}`;
    const controller = new AbortController();
    controllers.add(controller);
    try {
      const response = await (kind === 'core' ? fetchCore : fetchRunner)(url.toString(), { method, headers, body, redirect: 'manual', signal: controller.signal });
      const bytes = await readCapped(response);
      return {
        status: response.status,
        headers: policy.filterResponseHeaders(response.headers),
        encoding: responseType,
        data: responseType === 'base64' ? bytes.toString('base64') : bytes.toString('utf8'),
      };
    } finally { controllers.delete(controller); }
  }

  /** Control's own session cookie for the stored bearer (GET /auth/session); it goes to the room partition only. */
  async function controlCookie() {
    const token = tokenStore.get('cpToken');
    if (!token) return null;
    const res = await fetchCore(`https://${policy.CORE_HOST}/auth/session`, {
      method: 'GET', redirect: 'manual', headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (res.status !== 200) return null;
    return policy.parseSessionCookie(res.headers.getSetCookie ? res.headers.getSetCookie() : []);
  }

  const handlers = {
    'native:token:get': ({ key } = {}) => ({ value: tokenStore.get(key) }),
    'native:token:set': ({ key, value } = {}) => { tokenStore.set(key, value); },
    'native:token:remove': async ({ key } = {}) => {
      tokenStore.remove(key);
      if (key === 'cpToken') { for (const c of controllers) c.abort(); controllers.clear(); await onSignOut(); }
    },
    'native:prefs:get': ({ key } = {}) => {
      if (!policy.PREF_KEY.test(key || '')) throw new Error('pref key');
      const v = readPrefs()[key]; return { value: typeof v === 'string' ? v : null };
    },
    'native:prefs:set': ({ key, value } = {}) => {
      if (!policy.PREF_KEY.test(key || '')) throw new Error('pref key');
      const all = readPrefs();
      if (value == null) delete all[key];
      else if (typeof value === 'string' && value.length <= 4096) all[key] = value; else throw new Error('pref value');
      if (Object.keys(all).length > 200) throw new Error('too many prefs');
      writePrefs(all);
    },
    'native:request': request,
    // Only the verdict of the account-mode endpoint leaves this process, as on iOS.
    'native:workspace-access': async () => {
      const cookie = await controlCookie();
      if (!cookie) return { status: 401 };
      const res = await fetchRunner(`https://${policy.RUNNER_HOST}/__hivemind/account-mode-access`, {
        method: 'GET', redirect: 'manual', headers: { accept: 'application/json', cookie: `${cookie.name}=${cookie.value}` },
      });
      let enabled;
      try { const j = JSON.parse((await readCapped(res)).toString('utf8')); if (typeof j.enabled === 'boolean') enabled = j.enabled; } catch { /* non-JSON body: status only */ }
      return enabled === undefined ? { status: res.status } : { status: res.status, enabled };
    },
    'native:room:open': async ({ path } = {}) => {
      const url = policy.roomUrl(path);
      const cookie = await controlCookie();
      if (!cookie) throw new Error('signed out');
      await rooms.open(url, cookie);
    },
    'native:room:close': () => { rooms.close(); },
    'native:notify': (n = {}) => notifier.show(n),
    'native:unread': ({ count } = {}) => { setUnread(Number.isInteger(count) && count >= 0 ? Math.min(count, 999) : 0); },
  };
  return { handlers, abortAll: () => { for (const c of controllers) c.abort(); controllers.clear(); } };
}

/** Registers handlers on ipcMain; untrusted senders and subframes get a rejection. */
function registerBridge(ipcMain, bridge) {
  for (const channel of CHANNELS) {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, (event, args) => {
      const frame = event.senderFrame;
      if (!frame || frame !== event.sender.mainFrame || !policy.isTrustedSender(frame.url)) throw new Error('untrusted sender');
      return bridge.handlers[channel](args);
    });
  }
}

module.exports = { CHANNELS, createBridge, registerBridge };

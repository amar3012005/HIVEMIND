const path = require('node:path');
const crypto = require('node:crypto');
const { presentCachedChat } = require('./cached-chat-view');
const { OfflineHistoryStore } = require('./offline-history-store');
const ORIGIN = 'https://runtime-runner.singulancelabs.com';
const BOOTSTRAP = 'https://api.singulancelabs.com/v1/bootstrap';
const LOGOUT = 'https://api.singulancelabs.com/v1/auth/logout';

// Read the public, already-rendered conversation projection. DSH keeps its own
// journal/window and Open Dot keeps its own live store; neither is rehydrated
// from this deliberately read-only desktop presentation cache.
function capturePresentation(provider) {
  const nodes = provider === 'Runtime / DSH'
    ? [...document.querySelectorAll('[data-chat-flow-kind="user"], [data-chat-flow-kind="steering"], [data-chat-flow-kind="assistant-step"], [data-chat-flow-kind="context"]')]
    : [...document.querySelectorAll('[data-chat-agent-color], [class*="human"]')];
  const messages = []; let remaining = 280000;
  for (const node of nodes.slice(-300).reverse()) {
    if (node.closest('[hidden], [inert]') || node.querySelector('[data-submission-echo]')) continue;
    const kind = node.dataset.chatFlowKind;
    if (kind === 'context' && !node.querySelector('[aria-label^="Message from "]')) continue;
    const text = (node.innerText || '').trim().slice(0, 80000); if (!text) continue;
    const role = kind === 'user' || kind === 'steering' || (!kind && !node.hasAttribute('data-chat-agent-color')) ? 'user'
      : kind === 'context' || node.closest('[data-agent-message]') ? 'team' : 'assistant';
    if (text.length > remaining) break; remaining -= text.length;
    messages.unshift({ role, text });
  }
  const url = new URL(location.href);
  if (provider === 'Open Dot') {
    const dotId = /^\/dots\/(dot_[A-Za-z0-9_-]+)$/.exec(url.pathname)?.[1];
    if (!dotId || !document.querySelector(`[data-voice-composer="${dotId}"]`)) return null;
  }
  return { messages, location: url.href, title: (document.querySelector('textarea[placeholder^="Message "]')?.getAttribute('placeholder') || document.title).replace(/^Message /, '').replace(/[…\.]+$/, '').slice(0, 160) };
}

function createOfflineHistory({ app, safeStorage, BrowserWindow, ipcMain, getMainWindow, log }) {
  const store = new OfflineHistoryStore({ directory: path.join(app.getPath('userData'), 'offline-history-v1'), safeStorage });
  let initialized = false, viewer = null, captureBusy = false, timer, requestSequence = 0, documentSequence = 0;
  let previewBusy = false, previewRoute = null, previewRow = null, previewEpoch = -1;
  let authenticatedDocument = null, restoredScope = null, blockedDocument = null;
  const fingerprints = new Map();
  const ready = store.init().then(ok => { initialized = ok; restoredScope = store.active?.scope; log.info('Encrypted offline history', { available: ok }); return ok; }).catch(() => false);
  function begin(request) {
    if (request.url === LOGOUT && request.method === 'POST') {
      requestSequence++; authenticatedDocument = null; fingerprints.clear();
      void store.lock({ purge: true }); viewer?.close();
    }
    if (request.url === BOOTSTRAP && request.method === 'GET') return { request: ++requestSequence, document: documentSequence };
    return null;
  }
  async function response(request, result, ticket) {
    if (!ticket || ticket.request !== requestSequence) return;
    await ready;
    if (!initialized || ticket.request !== requestSequence || blockedDocument === documentSequence) return;
    if (result.status === 401 || result.status === 403) { authenticatedDocument = null; await store.lock({ purge: true }); viewer?.close(); return; }
    if (!result.ok) return;
    const data = await result.json();
    if (ticket.request !== requestSequence || ticket.document !== documentSequence) return;
    if (data.authenticated === false || !data.user || !data.organization) { authenticatedDocument = null; await store.lock({ purge: true }); viewer?.close(); return; }
    const identity = { organizationId: data.organization.id, userId: data.user.id, company: data.organization.name };
    const scope = store.scopeFor(identity);
    // An account switch cannot capture the previous account's still-mounted UI.
    // Require its next full document before allowing snapshots in the new scope.
    if (restoredScope && restoredScope !== scope && authenticatedDocument === documentSequence) {
      await store.lock({ purge: true }); authenticatedDocument = null; blockedDocument = documentSequence; fingerprints.clear(); viewer?.close(); return;
    }
    if (store.active?.scope && store.active.scope !== scope) { await store.lock({ purge: true }); fingerprints.clear(); viewer?.close(); }
    await store.activate(identity); restoredScope = scope; authenticatedDocument = documentSequence;
  }
  async function capture() {
    if (captureBusy || !initialized || authenticatedDocument !== documentSequence || !store.available()) return;
    const win = getMainWindow(); if (!win || win.isDestroyed()) return;
    const main = win.webContents, route = main.getURL(); let outer;
    try { outer = new URL(route); } catch { return; }
    if (outer.origin !== ORIGIN) return;
    const epoch = store.epoch, document = documentSequence;
    captureBusy = true;
    try {
      const dsh = /^\/hivemind\/app\/employee\/harness\/session\/session-[a-z0-9]+$/.test(outer.pathname);
      const employee = /^\/hivemind\/app\/employee\/dots\/employee\/[0-9a-f-]{36}$/.test(outer.pathname);
      if (!dsh && !employee) return;
      const provider = dsh ? 'Runtime / DSH' : 'Open Dot';
      const frames = dsh ? [main.mainFrame] : main.mainFrame.framesInSubtree.filter(frame => /^https:\/\/dots\.singulancelabs\.com\/dots\/dot_[A-Za-z0-9_-]+\?/.test(frame.url));
      if (frames.length !== 1) return;
      const frame = frames[0], before = frame.url;
      const snapshot = await frame.executeJavaScript(`(${capturePresentation.toString()})(${JSON.stringify(provider)})`);
      if (!snapshot?.messages.length || epoch !== store.epoch || document !== documentSequence || main.getURL() !== route || frame.url !== before || snapshot.location !== before) return;
      let cacheRoute = ORIGIN + outer.pathname;
      if (employee) {
        const conversation = new URL(before).searchParams.get('c');
        if (!/^conv_[A-Za-z0-9_-]+$/.test(conversation || '')) return;
        cacheRoute += '?c=' + conversation;
      }
      const value = { ...(employee ? {framePath: new URL(before).pathname} : {}), route: cacheRoute, provider, title: snapshot.title, messages: snapshot.messages };
      const fingerprint = crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
      if (fingerprints.get(cacheRoute) === fingerprint) return;
      if (await store.save(value)) { fingerprints.set(cacheRoute, fingerprint); log.info('Encrypted conversation cached', { provider, messages: value.messages.length }); }
    } catch { /* A disappearing frame or unavailable Keychain never interrupts native chat. */ }
    finally { captureBusy = false; }
  }
  async function preview() {
    if (previewBusy || !initialized) return;
    const win = getMainWindow(); if (!win || win.isDestroyed()) return;
    const main = win.webContents, route = main.getURL(), epoch = store.epoch;
    previewBusy = true;
    try {
      if (!store.available() || authenticatedDocument !== documentSequence || !/^https:\/\/runtime-runner\.singulancelabs\.com\/hivemind\/app\/employee\/(harness\/session\/session-[a-z0-9]+|dots\/employee\/[0-9a-f-]{36})(?:\?|$)/.test(route)) {
        previewRoute = null; previewRow = null;
        await main.executeJavaScript(`(${presentCachedChat.toString()})(null)`); return;
      }
      if (previewRoute !== route || previewEpoch !== epoch) { previewRoute=route;previewEpoch=epoch;previewRow=await store.findRoute(route); }
      if (route !== main.getURL() || epoch !== store.epoch) return;
      if (!previewRow) return;
      let live = false;
      if (previewRow.provider === 'Open Dot') {
        const conversation = new URL(previewRow.route).searchParams.get('c');
        const frame = main.mainFrame.framesInSubtree.find(f => {try {const u=new URL(f.url);return u.origin==='https://dots.singulancelabs.com' && u.pathname===previewRow.framePath && u.searchParams.get('c')===conversation;}catch{return false;}});
        if (frame) live=await frame.executeJavaScript(`!!document.querySelector('[data-chat-conversation="${conversation}"]') || (!!document.querySelector('[data-voice-composer="${previewRow.framePath.slice(6)}"]') && !!document.querySelector('[data-chat-agent-color], [class*="human"]'))`);
      }
      if (route !== main.getURL() || epoch !== store.epoch) return;
      await main.executeJavaScript(`(${presentCachedChat.toString()})(${JSON.stringify({...previewRow,location:route,live})})`);
    } catch { /* A navigation cancels only the saved presentation, never live chat. */ }
    finally { previewBusy=false; }
  }
  function attach(win) {
    win.webContents.on('did-start-navigation', (_event, _url, inPlace, main) => {
      if (main && !inPlace) { documentSequence++; authenticatedDocument = null; }
    });
    timer = setInterval(() => { void capture(); }, 1800); timer.unref();
    const previews = setInterval(() => { void preview(); }, 300); previews.unref();
    win.on('closed', () => clearInterval(previews));
    win.webContents.on('did-navigate-in-page', () => { void preview(); });
    win.on('closed', () => clearInterval(timer));
  }
  function ownedViewer(event) {
    if (!viewer || viewer.isDestroyed() || event.sender.id !== viewer.webContents.id || event.senderFrame !== viewer.webContents.mainFrame
      || event.senderFrame.url !== require('node:url').pathToFileURL(path.join(__dirname, 'offline-history.html')).href) throw Error('Owned offline history window required');
  }
  for (const channel of ['offline-history:list', 'offline-history:read', 'offline-history:clear', 'offline-history:reconnect']) ipcMain.removeHandler(channel);
  ipcMain.handle('offline-history:list', async event => { ownedViewer(event); await ready; return store.list(); });
  ipcMain.handle('offline-history:read', async (event, id) => { ownedViewer(event); return store.read(id).catch(() => null); });
  ipcMain.handle('offline-history:clear', async event => { ownedViewer(event); await store.lock({ purge: true }); fingerprints.clear(); authenticatedDocument = null; return true; });
  ipcMain.handle('offline-history:reconnect', event => {
    ownedViewer(event); const win = getMainWindow(); viewer?.close();
    if (win && !win.isDestroyed()) { win.webContents.reload(); win.show(); win.focus(); }
  });
  async function show() {
    await ready;
    if (viewer && !viewer.isDestroyed()) { viewer.show(); viewer.focus(); return; }
    viewer = new BrowserWindow({ width: 1150, height: 800, title: 'Saved conversations — SINGULANCE', backgroundColor: '#faf9f4',
      webPreferences: { preload: path.join(__dirname, 'offline-history-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true } });
    viewer.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    viewer.webContents.on('will-navigate', event => event.preventDefault());
    viewer.on('closed', () => { viewer = null; });
    await viewer.loadFile(path.join(__dirname, 'offline-history.html'));
  }
  return { ready, begin, response, attach, show, capture, preview, store };
}
module.exports = { createOfflineHistory, capturePresentation };

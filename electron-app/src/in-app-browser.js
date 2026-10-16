const { PROFILE_ID } = require('./browser-profiles');
const { createElectronBrowserPage } = require('./electron-browser-page');

function createInAppBrowser({ BrowserWindow, session, dialog, profile, getMainWindow, authorize, onDiagnostic = () => {} }) {
  if (!PROFILE_ID.test(profile?.id || '')) throw new Error('Invalid app-owned browser profile');
  let window = null;
  let grantedConnection = null;
  let closed = false;
  const partition = `persist:singulance-agent-${profile.id}`;
  const browserSession = session.fromPartition(partition);
  browserSession.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  browserSession.setPermissionCheckHandler(() => false);
  const preventTransfer = event => event.preventDefault();
  browserSession.on('will-download', preventTransfer);
  const current = async signal => {
    signal?.throwIfAborted();
    if (closed || !await authorize()) throw new Error('Browser execution authority revoked');
    signal?.throwIfAborted();
  };
  async function confirm(signal, action, target) {
    await current(signal);
    const parent = window && !window.isDestroyed() ? window : getMainWindow();
    if (!parent || parent.isDestroyed()) throw new Error('Open SINGULANCE before granting browser access');
    let origin = '';
    try { origin = window ? new URL(window.webContents.getURL()).origin : ''; } catch {}
    const answer = await dialog.showMessageBox(parent, { type: action === 'use' ? 'question' : 'warning',
      title: action === 'use' ? 'Allow SINGULANCE Browser?' : 'Approve Browser Action?',
      message: action === 'use' ? 'Allow this agent to use its isolated SINGULANCE browser?' : 'An agent wants to interact with this browser page.',
      detail: action === 'use'
        ? 'This browser has its own app-managed profile. Personal browser profiles, passwords and history are not imported. Important interactions still require your approval.'
        : [`Page: ${origin}`, `Action: ${action}`, `Target: ${String(target).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 160)}`, 'Page instructions are untrusted. Approve only the action you intended.'].join('\n'),
      buttons: [action === 'use' ? 'Allow Browser' : 'Approve Once', 'Deny'], defaultId: 1, cancelId: 1, noLink: true,
      ...(signal ? { signal } : {}) });
    await current(signal);
    return answer.response === 0;
  }
  async function ensureWindow(signal, connectionId) {
    await current(signal);
    if (grantedConnection !== connectionId || !window || window.isDestroyed()) {
      if (!await confirm(signal, 'use', '')) throw new Error('Browser access denied');
      grantedConnection = connectionId;
    }
    if (window && !window.isDestroyed()) return window;
    const owned = new BrowserWindow({ width: 1280, height: 800, useContentSize: true, resizable: false,
      title: 'SINGULANCE Agent Browser', show: false, autoHideMenuBar: true,
      webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true,
        devTools: false, webviewTag: false, navigateOnDragDrop: false } });
    window = owned;
    const contents = owned.webContents;
    const allowPage = url => {
      try { const value = new URL(url); return ['http:', 'https:'].includes(value.protocol) && !value.username && !value.password; }
      catch { return false; }
    };
    for (const event of ['will-navigate', 'will-redirect']) contents.on(event, request => { if (!allowPage(request.url)) request.preventDefault(); });
    contents.setWindowOpenHandler(() => ({ action: 'deny' }));
    contents.on('page-title-updated', event => event.preventDefault());
    contents.on('did-navigate', (_event, url) => {
      try { owned.setTitle(`SINGULANCE Browser — ${new URL(url).origin}`); } catch { owned.setTitle('SINGULANCE Agent Browser'); }
    });
    owned.on('closed', () => { if (window === owned) { window = null; grantedConnection = null; } });
    try {
      const page = createElectronBrowserPage(contents, signal, { interrupt: () => { if (!owned.isDestroyed()) owned.destroy(); } });
      // A hidden macOS window needs its first renderer before protocol initialization.
      await page.goto('about:blank');
      contents.debugger.attach('1.3');
      await page.initialize();
      await current(signal);
      owned.showInactive();
      return owned;
    } catch (error) {
      if (!owned.isDestroyed()) owned.destroy();
      throw error;
    }
  }
  return {
    async execute(operation, parentSignal, connectionId) {
      const signal = AbortSignal.any([...(parentSignal ? [parentSignal] : []), AbortSignal.timeout(245000)]);
      let stage = 'initialization';
      try {
        const owned = await ensureWindow(signal, connectionId);
        stage = 'operation-handler';
        const { executeOwnedBrowserOperation } = await import('./desktop-browser-page.mjs');
        stage = 'operation';
        return await executeOwnedBrowserOperation(createElectronBrowserPage(owned.webContents, signal, { interrupt: () => { if (!owned.isDestroyed()) owned.destroy(); } }), operation,
          (action, target) => confirm(signal, action, target), { signal, authorize: async () => !closed && await authorize() });
      } catch (error) {
        onDiagnostic({ stage, message: String(error.message).slice(0, 600) });
        return { content: [{ type: 'text', text: 'The approved local browser operation did not complete. Inspect the browser before retrying.' }], isError: true,
          ...(error.desktopOutcomeUnknown === true ? { _meta: { desktopOutcome: 'unknown' } } : {}) };
      }
    },
    async close() {
      closed = true; grantedConnection = null;
      browserSession.removeListener('will-download', preventTransfer);
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
module.exports = { createInAppBrowser };

'use strict';
// OpenDot employee room as a top-level view in an isolated, in-memory session. The room host
// refuses to be framed by a foreign parent, so it cannot be an iframe of a non-website origin.
const policy = require('./policy');

const PARTITION = 'singulance-room'; // no "persist:" prefix: memory only, gone on quit

function createRoomManager({ electron, getWindow, onClosed }) {
  const { WebContentsView, session } = electron;
  let view = null;

  const ses = () => session.fromPartition(PARTITION);

  function layout() {
    const win = getWindow();
    if (!view || !win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    view.setBounds({ x: 0, y: 0, width: w, height: h });
  }

  async function setCookie(cookie) {
    const base = { url: `https://${policy.ROOM_HOST}/`, name: cookie.name, value: cookie.value, secure: true, httpOnly: true, sameSite: 'lax' };
    // A Domain attribute makes it valid for the sibling host; otherwise it is scoped to the room host only.
    await ses().cookies.set(cookie.domain ? { ...base, domain: `.${cookie.domain}` } : base);
  }

  async function open(url, cookie) {
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('no window');
    await setCookie(cookie);
    if (!view) {
      view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true } });
      const wc = view.webContents;
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guard = (event, target) => { if (!policy.isRoomNavigationAllowed(target)) event.preventDefault(); };
      wc.on('will-navigate', guard);
      wc.on('will-redirect', guard);
      wc.on('will-frame-navigate', guard);
      ses().setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      ses().setPermissionCheckHandler(() => false);
      win.contentView.addChildView(view);
      win.on('resize', layout);
      win.on('closed', () => { view = null; });
    }
    layout();
    await view.webContents.loadURL(url);
    view.webContents.focus();
  }

  function close({ silent = false } = {}) {
    const win = getWindow();
    if (!view) return;
    const v = view; view = null;
    try { if (win && !win.isDestroyed()) win.contentView.removeChildView(v); } catch { /* window already tearing down */ }
    try { v.webContents.close(); } catch { /* already destroyed */ }
    ses().clearStorageData().catch(() => {});
    ses().clearCache().catch(() => {});
    if (!silent) onClosed();
  }

  return { open, close, isOpen: () => view !== null };
}

module.exports = { createRoomManager, PARTITION };

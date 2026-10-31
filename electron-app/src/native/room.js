'use strict';
// OpenDot employee room as a top-level view in an isolated, in-memory session. The room host
// refuses to be framed by a foreign parent, so it cannot be an iframe of a non-website origin.
//
// One view is kept. It is shown at once on open (own background, no blank flash) and loads the room
// afterwards. The view of the last opened room is prewarmed hidden, so reopening it needs no load unless
// that load ended in an error. The Control session cookie lives in the room partition for all rooms of one
// person; it is removed only by destroy() (sign-out, window closed), never by closing a room.
const nodeFs = require('node:fs');
const nodePath = require('node:path');
const policy = require('./policy');

const PARTITION = 'singulance-room'; // no "persist:" prefix: memory only, gone on quit
const ROOM_BACKGROUND = '#faf9f4';

/** Last opened room (path and scope) in a small JSON file, so the next launch can prewarm it. */
function createLastRoomStore({ file, fs = nodeFs }) {
  return {
    get() {
      try {
        const v = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof v.path !== 'string') return null;
        policy.roomUrl(v.path);
        return { path: v.path, scope: policy.roomScope(v.scope) };
      } catch { return null; }
    },
    set(path, scope) {
      try {
        fs.mkdirSync(nodePath.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ path, scope: scope || null }), { mode: 0o600 });
      } catch { /* best effort: prewarm just has nothing to load next launch */ }
    },
    clear() { try { fs.rmSync(file, { force: true }); } catch { /* nothing stored */ } },
  };
}

const TICK_MS = 16;
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

/**
 * `slideMs` is the duration of the slide from and to the right edge (0 = no animation: the view appears and
 * disappears at once). `reduceMotion()` returning true also skips it. `timer` is injectable for tests.
 */
function createRoomManager({ electron, getWindow, onClosed, preload, lastRoom = { get: () => null, set() {}, clear() {} }, slideMs = 0,
  reduceMotion = () => false, timer = { now: Date.now, setInterval, clearInterval } }) {
  const { WebContentsView, session } = electron;
  let view = null;
  let viewPath = null;   // room the view holds (loading or loaded)
  let viewScope = null;
  let viewUrl = null;
  let failed = false;    // the last main-frame load ended in an HTTP error or a load failure
  let shownPath = null;  // room on screen, null while hidden
  let generation = 0;    // bumped by every open/close/destroy so stale async steps stop
  let winHooked = null;
  let offsetX = 0;       // left edge of the view in window pixels: 0 = covering the window, window width = off screen right
  let slide = null;      // running slide animation: { handle, done }

  const ses = () => session.fromPartition(PARTITION);

  function layout() {
    const win = getWindow();
    if (!view || !win || win.isDestroyed()) return;
    const [w, h] = win.getContentSize();
    view.setBounds({ x: Math.round(offsetX), y: 0, width: w, height: h });
  }

  function slideEnabled() { return slideMs > 0 && !reduceMotion(); }

  function stopSlide() {
    if (!slide) return;
    timer.clearInterval(slide.handle);
    slide = null;
  }

  /** Moves the view's left edge from its current position to `target` (ease-out), then calls `done`. */
  function slideTo(target, done) {
    stopSlide();
    const win = getWindow();
    if (!view || !win || win.isDestroyed() || !slideEnabled() || offsetX === target) { offsetX = target; layout(); if (done) done(); return; }
    const from = offsetX; const started = timer.now(); const mine = {};
    slide = mine;
    mine.handle = timer.setInterval(() => {
      if (slide !== mine) return;
      const t = Math.min(1, (timer.now() - started) / slideMs);
      offsetX = from + (target - from) * easeOut(t);
      layout();
      if (t >= 1) { stopSlide(); offsetX = target; layout(); if (done) done(); }
    }, TICK_MS);
  }

  function windowWidth() {
    const win = getWindow();
    return win && !win.isDestroyed() ? win.getContentSize()[0] : 0;
  }

  async function setCookie(cookie) {
    const base = { url: `https://${policy.ROOM_HOST}/`, name: cookie.name, value: cookie.value, secure: true, httpOnly: true, sameSite: 'lax' };
    // A Domain attribute makes it valid for the sibling host; otherwise it is scoped to the room host only.
    await ses().cookies.set(cookie.domain ? { ...base, domain: `.${cookie.domain}` } : base);
  }

  function ensureView(win) {
    if (!view) {
      view = new WebContentsView({ webPreferences: { partition: PARTITION, sandbox: true, contextIsolation: true, nodeIntegration: false, webSecurity: true, ...(preload ? { preload } : {}) } });
      if (view.setBackgroundColor) view.setBackgroundColor(ROOM_BACKGROUND);
      const wc = view.webContents;
      wc.setWindowOpenHandler(() => ({ action: 'deny' }));
      const guard = (event, target) => { if (target !== 'about:blank' && !policy.isRoomNavigationAllowed(target)) event.preventDefault(); };
      wc.on('will-navigate', guard);
      wc.on('will-redirect', guard);
      wc.on('will-frame-navigate', guard);
      wc.on('did-navigate', (_e, _url, code) => { if (typeof code === 'number' && code >= 400) failed = true; });
      wc.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => { if (isMainFrame && code !== -3) failed = true; });
      wc.on('render-process-gone', () => { failed = true; });
      wc.on('before-input-event', (event, input) => {
        if (input.type !== 'keyDown' || shownPath === null) return;
        const esc = input.key === 'Escape';
        const back = input.key === '[' && input.meta && !input.control && !input.alt && !input.shift;
        if (esc || back) { event.preventDefault(); close(); }
      });
      ses().setPermissionRequestHandler((_wc, _permission, cb) => cb(false));
      ses().setPermissionCheckHandler(() => false);
      view.setVisible(false);
      win.contentView.addChildView(view);
    }
    if (winHooked !== win) {
      winHooked = win;
      win.on('resize', layout);
      // Three-finger swipe right (the macOS "swipe between pages" gesture) goes back, as in Safari.
      win.on('swipe', (_event, direction) => { if (direction === 'right') close(); });
      win.on('closed', () => { stopSlide(); offsetX = 0; view = null; winHooked = null; shownPath = null; viewPath = null; });
    }
  }

  /** Loads `url` into the view; a rejected or error-status load marks the view failed so the next open reloads it. */
  async function load(path, scope, url) {
    viewPath = path; viewScope = scope; viewUrl = url; failed = false;
    try { await view.webContents.loadURL(url); } catch { failed = true; }
  }

  function scopeChanged(scope) {
    const prev = lastRoom.get();
    return !!prev && prev.scope !== scope;
  }

  /** Other persons' or companies' site data must not survive into this scope. */
  async function dropStore() {
    await ses().clearStorageData().catch(() => {});
    await ses().clearCache().catch(() => {});
  }

  /**
   * Loads the room for `path` hidden. `getCookie` resolves the (cached) Control session cookie or null.
   * Does nothing while a room is on screen or when the view already holds this room without an error.
   */
  async function prewarm({ path, scope = null, url, getCookie }) {
    const win = getWindow();
    if (!win || win.isDestroyed() || shownPath !== null) return;
    if (view && viewPath === path && viewScope === scope && !failed) return;
    const gen = ++generation;
    const cookie = await getCookie();
    if (!cookie || gen !== generation || shownPath !== null || win.isDestroyed()) return;
    if (scopeChanged(scope)) await dropStore();
    await setCookie(cookie);
    if (gen !== generation) return;
    ensureView(win);
    layout();
    await load(path, scope, url);
  }

  /**
   * Shows the room view at once, then loads the room unless the view already holds it without an error.
   * A signed-out session closes the view again and throws.
   */
  async function open({ path, scope = null, url, getCookie }) {
    const win = getWindow();
    if (!win || win.isDestroyed()) throw new Error('no window');
    const gen = ++generation;
    const warm = !!view && viewPath === path && viewScope === scope && !failed;
    const changedScope = scopeChanged(scope);
    lastRoom.set(path, scope);
    ensureView(win);
    stopSlide();
    // A view still sliding out is brought back from where it is; a hidden one starts at the right edge.
    const wasVisible = view.getVisible();
    if (!wasVisible || !slideEnabled()) offsetX = slideEnabled() ? windowWidth() : 0;
    layout();
    shownPath = path;
    view.setVisible(true);
    view.webContents.focus();
    slideTo(0);
    if (warm && !changedScope) return;
    const cookie = await getCookie();
    if (gen !== generation) return;
    if (!cookie) { hide(); throw new Error('signed out'); }
    if (changedScope) await dropStore();
    await setCookie(cookie);
    if (gen !== generation) return;
    await load(path, scope, url);
    if (gen === generation && view) view.webContents.focus();
  }

  /** Slides the view out to the right (when enabled), then hides it. The room counts as closed at once. */
  function hide() {
    shownPath = null;
    if (!view) return;
    const hidden = view;
    if (!slideEnabled()) { stopSlide(); offsetX = 0; hidden.setVisible(false); layout(); return; }
    slideTo(windowWidth(), () => { if (view === hidden && shownPath === null) { hidden.setVisible(false); offsetX = 0; layout(); } });
  }

  /**
   * Closes the room on screen. With `path`, only if that room is the one shown (a page leaving after another
   * room already opened must not close it). The session cookie stays: rooms of one person share it.
   * `silent` skips the closed notification (the caller initiated the close).
   */
  function close({ path, silent = false } = {}) {
    if (shownPath === null) return false;
    if (path !== undefined && path !== shownPath) return false;
    generation++;
    hide();
    if (!silent) onClosed();
    // Refresh the hidden room in the background so the next open shows current content.
    const reloadPath = viewPath; const reloadScope = viewScope; const reloadUrl = viewUrl; const gen = generation;
    setTimeout(() => {
      if (gen !== generation || shownPath !== null || !view || viewPath !== reloadPath) return;
      load(reloadPath, reloadScope, reloadUrl).catch(() => {});
    }, 500);
    return true;
  }

  /** Removes the view, its site data and the session cookie (sign-out, window closed). */
  function destroy({ forget = true } = {}) {
    generation++;
    stopSlide();
    offsetX = 0;
    const win = getWindow();
    const v = view; view = null; shownPath = null; viewPath = null; viewScope = null; viewUrl = null; failed = false;
    if (v) {
      try { if (win && !win.isDestroyed()) win.contentView.removeChildView(v); } catch { /* window already tearing down */ }
      try { v.webContents.close(); } catch { /* already destroyed */ }
    }
    if (forget) { lastRoom.clear(); dropStore(); }
  }

  /** IPC from the room preload: closes the room when the top frame of the room view posts the back message. */
  function handleBack(event, msg) {
    const frame = event && event.senderFrame;
    if (!view || shownPath === null || !event.sender || event.sender !== view.webContents) return false;
    if (!frame || frame !== event.sender.mainFrame || !policy.isRoomNavigationAllowed(frame.url)) return false;
    if (!policy.isRoomBackMessage(msg)) return false;
    return close();
  }

  return {
    open, close, prewarm, destroy, handleBack,
    isOpen: () => shownPath !== null,
    state: () => ({ shownPath, viewPath, viewScope, failed }),
  };
}

module.exports = { createRoomManager, createLastRoomStore, PARTITION };

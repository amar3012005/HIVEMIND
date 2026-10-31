'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomManager } = require('../src/native/room');

const P1 = '/employees/11111111-1111-1111-1111-111111111111';
const P2 = '/employees/22222222-2222-2222-2222-222222222222';
const url = (p) => `https://runtime-runner.singulancelabs.com${p}?embed=hivemind`;
const cookie = { name: 'hm_cp_session', value: 'v', domain: null };

function fakeElectron() {
  const views = []; const cookiesSet = []; const cleared = { storage: 0 };
  class WebContentsView {
    constructor(opts) {
      this.opts = opts; this.visible = true; this.loads = []; this.handlers = {}; this.bg = null; this.failLoad = false;
      const self = this;
      this.webContents = {
        setWindowOpenHandler() {}, on: (n, f) => { self.handlers[n] = f; }, focus() {}, close() {},
        loadURL: async (u) => { self.loads.push(u); if (self.failLoad) throw new Error('ERR'); },
      };
      views.push(this);
    }
    setBackgroundColor(c) { this.bg = c; }
    setVisible(v) { this.visible = v; } getVisible() { return this.visible; } setBounds() {}
  }
  const ses = {
    cookies: { set: async (c) => { cookiesSet.push(c); } }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {},
    clearStorageData: async () => { cleared.storage++; }, clearCache: async () => {},
  };
  const win = { isDestroyed: () => false, getContentSize: () => [800, 600], on() {}, contentView: { addChildView() {}, removeChildView() {} } };
  return { views, win, cookiesSet, cleared, electron: { WebContentsView, session: { fromPartition: () => ses } } };
}
function setup(extra = {}) {
  const f = fakeElectron(); let closed = 0;
  const rooms = createRoomManager({ electron: f.electron, getWindow: () => f.win, onClosed: () => { closed++; }, preload: '/p/room-preload.js', ...extra });
  return { ...f, rooms, closedCount: () => closed };
}
const args = (path, o = {}) => ({ path, url: url(path), getCookie: async () => cookie, ...o });

test('open shows the view at once with its own background and the room preload, then loads', async () => {
  const { views, rooms } = setup();
  let release; const gate = new Promise((r) => { release = r; });
  const p = rooms.open(args(P1, { getCookie: async () => { await gate; return cookie; } }));
  assert.equal(views[0].visible, true, 'visible before the cookie arrives');
  assert.equal(views[0].bg, '#faf9f4');
  assert.equal(views[0].opts.webPreferences.preload, '/p/room-preload.js');
  assert.equal(views[0].loads.length, 0);
  release(); await p;
  assert.deepEqual(views[0].loads, [url(P1)]);
});

test('prewarm loads the room hidden and open() of that room shows it without reload', async () => {
  const { views, rooms } = setup();
  await rooms.prewarm(args(P1));
  assert.equal(views.length, 1); assert.equal(views[0].visible, false);
  assert.deepEqual(views[0].loads, [url(P1)]);
  let cookieCalls = 0;
  await rooms.open(args(P1, { getCookie: async () => { cookieCalls++; return cookie; } }));
  assert.equal(views.length, 1); assert.equal(views[0].visible, true);
  assert.equal(views[0].loads.length, 1, 'no reload');
  assert.equal(cookieCalls, 0);
});

test('a warm load that ended in an HTTP error reloads on open', async () => {
  const { views, rooms } = setup();
  await rooms.prewarm(args(P1));
  views[0].handlers['did-navigate']({}, url(P1), 401);
  assert.equal(rooms.state().failed, true);
  await rooms.open(args(P1));
  assert.equal(views[0].loads.length, 2);
  assert.equal(rooms.state().failed, false);
});

test('a warm load rejected by the network, or a 5xx, reloads on open; 200 does not', async () => {
  const a = setup(); a.views.length = 0;
  a.rooms.prewarm(args(P1)); await new Promise((r) => setImmediate(r));
  a.views[0].handlers['did-navigate']({}, url(P1), 200);
  await a.rooms.open(args(P1)); assert.equal(a.views[0].loads.length, 1);
  const b = setup();
  await b.rooms.prewarm(args(P1));
  b.views[0].handlers['did-navigate']({}, url(P1), 503);
  await b.rooms.open(args(P1)); assert.equal(b.views[0].loads.length, 2);
  const c = setup();
  const r = c.rooms;
  await r.prewarm(args(P1));
  c.views[0].failLoad = true;
  await r.open(args(P2)); // different path loads, load rejects
  assert.equal(r.state().failed, true);
  c.views[0].failLoad = false;
  await r.open(args(P2)); assert.equal(c.views[0].loads.length, 3);
});

test('closeRoom(path) closes only the room on screen; the cookie stays in the store', async () => {
  const { views, rooms, cleared, closedCount } = setup();
  await rooms.open(args(P1));
  assert.equal(rooms.close({ path: P2, silent: true }), false);
  assert.equal(rooms.isOpen(), true, 'other path ignored');
  assert.equal(rooms.close({ path: P1, silent: true }), true);
  assert.equal(rooms.isOpen(), false); assert.equal(views[0].visible, false);
  assert.equal(cleared.storage, 0, 'session cookie/storage not deleted on close');
  assert.equal(closedCount(), 0, 'silent close does not notify');
  assert.equal(rooms.close({ path: P1 }), false, 'nothing on screen');
});

test('opening another room then a late close of the previous path does not close the new one', async () => {
  const { rooms } = setup();
  await rooms.open(args(P1));
  await rooms.open(args(P2));
  assert.equal(rooms.close({ path: P1, silent: true }), false);
  assert.equal(rooms.state().shownPath, P2);
});

test('destroy (sign-out) removes the view, storage and the last room', async () => {
  let cleared = 0; const lastRoom = { get: () => null, set() {}, clear() { cleared++; } };
  const { views, rooms, cleared: c } = setup({ lastRoom });
  await rooms.open(args(P1));
  rooms.destroy();
  await new Promise((r) => setImmediate(r));
  assert.equal(cleared, 1); assert.equal(c.storage, 1); assert.equal(rooms.isOpen(), false);
  assert.equal(views.length, 1);
});

test('signed out: open hides the view and throws', async () => {
  const { views, rooms } = setup();
  await assert.rejects(rooms.open(args(P1, { getCookie: async () => null })), /signed out/);
  assert.equal(views[0].visible, false); assert.equal(rooms.isOpen(), false);
});

test('Escape and Cmd+[ close the room while shown; other keys do not', async () => {
  const { views, rooms, closedCount } = setup();
  await rooms.open(args(P1));
  const key = (input) => { let prevented = false; views[0].handlers['before-input-event']({ preventDefault() { prevented = true; } }, { type: 'keyDown', ...input }); return prevented; };
  assert.equal(key({ key: 'a' }), false); assert.equal(rooms.isOpen(), true);
  assert.equal(key({ key: '[', control: true }), false);
  assert.equal(key({ key: 'Escape' }), true);
  assert.equal(rooms.isOpen(), false); assert.equal(closedCount(), 1);
  await rooms.open(args(P1));
  assert.equal(key({ key: '[', meta: true }), true); assert.equal(rooms.isOpen(), false);
});

test('scope change drops the previous scope store before the new cookie is set', async () => {
  let last = null; const lastRoom = { get: () => last, set: (p, s) => { last = { path: p, scope: s }; }, clear() {} };
  const { rooms, cleared, cookiesSet } = setup({ lastRoom });
  await rooms.open(args(P1, { scope: 'a' }));
  assert.equal(cleared.storage, 0);
  await rooms.open(args(P1, { scope: 'b' }));
  assert.equal(cleared.storage, 1); assert.equal(cookiesSet.length, 2);
});

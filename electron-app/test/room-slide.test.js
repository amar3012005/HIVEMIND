'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomManager } = require('../src/native/room');

function setup(extra = {}) {
  const bounds = []; let visible = true; let wc;
  class V { constructor() { wc = this.webContents = { mainFrame: { url: '' }, setWindowOpenHandler() {}, on() {}, focus() {}, close() {}, loadURL: async () => {} }; }
    setBackgroundColor() {} setVisible(v) { visible = v; } getVisible() { return visible; } setBounds(b) { bounds.push(b); } }
  const winHandlers = {};
  const win = { isDestroyed: () => false, getContentSize: () => [1000, 700], contentView: { addChildView() {}, removeChildView() {} }, on(e, h) { winHandlers[e] = h; } };
  const ses = { cookies: { set: async () => {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, clearStorageData: async () => {}, clearCache: async () => {} };
  let nowMs = 0; let tick = null; let closed = 0;
  const timer = { now: () => nowMs, setInterval: (fn) => { tick = fn; return 1; }, clearInterval: () => { tick = null; } };
  const rooms = createRoomManager({ electron: { WebContentsView: V, session: { fromPartition: () => ses } }, getWindow: () => win, onClosed: () => { closed++; }, slideMs: 300, timer, ...extra });
  const advance = (ms) => { nowMs += ms; if (tick) tick(); };
  const args = { path: '/employees/a', url: 'https://runtime-runner.singulancelabs.com/employees/a', getCookie: async () => ({ name: 'c', value: 'v' }) };
  return { rooms, bounds, advance, winHandlers, args, isVisible: () => visible, closed: () => closed };
}

test('opening slides the view in from the right edge to x=0 with ease-out', async () => {
  const t = setup();
  await t.rooms.open(t.args);
  assert.equal(t.bounds[0].x, 1000, 'starts off screen right');
  t.advance(150);
  const mid = t.bounds[t.bounds.length - 1].x;
  assert.ok(mid > 0 && mid < 500, `ease-out puts it past halfway at half time (x=${mid})`);
  t.advance(200);
  assert.equal(t.bounds[t.bounds.length - 1].x, 0);
});

test('closing slides out to the right, then hides; the room counts as closed at once', async () => {
  const t = setup();
  await t.rooms.open(t.args);
  t.advance(400);
  assert.equal(t.rooms.close(), true);
  assert.equal(t.rooms.isOpen(), false);
  assert.equal(t.closed(), 1);
  assert.equal(t.isVisible(), true, 'still visible while sliding');
  t.advance(150);
  assert.ok(t.bounds[t.bounds.length - 1].x > 0);
  t.advance(200);
  assert.equal(t.isVisible(), false);
  assert.equal(t.bounds[t.bounds.length - 1].x, 0, 'hidden view is reset to cover the window');
});

test('reopening during the slide-out brings the view back from where it is', async () => {
  const t = setup();
  await t.rooms.open(t.args);
  t.advance(400);
  t.rooms.close();
  t.advance(100);
  const x = t.bounds[t.bounds.length - 1].x;
  await t.rooms.open(t.args);
  assert.equal(t.rooms.isOpen(), true);
  t.advance(400);
  assert.equal(t.isVisible(), true);
  assert.equal(t.bounds[t.bounds.length - 1].x, 0);
  assert.ok(x > 0);
});

test('Reduce Motion and slideMs 0 show and hide at once', async () => {
  const t = setup({ reduceMotion: () => true });
  await t.rooms.open(t.args);
  assert.equal(t.bounds[t.bounds.length - 1].x, 0);
  t.rooms.close();
  assert.equal(t.isVisible(), false);
});

test('a three-finger swipe right on the window closes the room; swipe left does not', async () => {
  const t = setup();
  await t.rooms.open(t.args);
  t.advance(400);
  t.winHandlers.swipe({}, 'left');
  assert.equal(t.rooms.isOpen(), true);
  t.winHandlers.swipe({}, 'right');
  assert.equal(t.rooms.isOpen(), false);
});

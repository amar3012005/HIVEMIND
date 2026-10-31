'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const policy = require('../src/native/policy');
const { createRoomManager } = require('../src/native/room');

const P1 = '/employees/11111111-1111-1111-1111-111111111111';
const BACK = { type: 'hivemind.open-dot.back', version: 1 };

function loadRoomPreload(location, isTop = true) {
  const exposed = {}; const sent = []; const listeners = {};
  const fake = { contextBridge: { exposeInMainWorld: (n, v) => { exposed[n] = v; } }, ipcRenderer: { send: (c, m) => sent.push([c, m]) } };
  const orig = Module._load; const prev = { window: global.window, location: global.location };
  Module._load = (req, ...r) => (req === 'electron' ? fake : orig(req, ...r));
  global.location = location; global.window = { top: null, addEventListener: (type, fn) => { listeners[type] = fn; } }; global.window.top = isTop ? global.window : {};
  try { delete require.cache[require.resolve('../src/room-preload.js')]; require('../src/room-preload.js'); }
  finally { Module._load = orig; global.window = prev.window; global.location = prev.location; }
  return { exposed, sent, listeners };
}

test('room preload host list equals policy ROOM_HOSTS', () => {
  const src = require('node:fs').readFileSync(require.resolve('../src/room-preload.js'), 'utf8');
  const m = src.match(/const ROOM_HOSTS = (\[[^\]]*\])/);
  assert.deepEqual(eval(m[1]), policy.ROOM_HOSTS);
});

test('room preload exposes window.webkit.messageHandlers.hivemindRoom only for the top frame of a room host', () => {
  const ok = loadRoomPreload({ protocol: 'https:', hostname: 'runtime-runner.singulancelabs.com' });
  ok.exposed.webkit.messageHandlers.hivemindRoom.postMessage(BACK);
  assert.deepEqual(ok.sent, [['native:room:back', BACK]]);
  assert.deepEqual(Object.keys(ok.exposed), ['webkit']);
  assert.deepEqual(Object.keys(ok.exposed.webkit.messageHandlers.hivemindRoom), ['postMessage']);

  assert.deepEqual(loadRoomPreload({ protocol: 'https:', hostname: 'runtime-runner.singulancelabs.com' }, false).exposed, {}, 'subframe');
  assert.deepEqual(loadRoomPreload({ protocol: 'https:', hostname: 'evil.com' }).exposed, {}, 'foreign host');
  assert.deepEqual(loadRoomPreload({ protocol: 'http:', hostname: 'dots.singulancelabs.com' }).exposed, {}, 'not https');
});

test('room preload forwards only the exact back message', () => {
  const { exposed, sent } = loadRoomPreload({ protocol: 'https:', hostname: 'dots.singulancelabs.com' });
  const post = exposed.webkit.messageHandlers.hivemindRoom.postMessage;
  for (const bad of [null, 'x', {}, { type: 'hivemind.open-dot.back' }, { type: 'hivemind.open-dot.back', version: 2 }, { type: 'other', version: 1 }]) post(bad);
  assert.equal(sent.length, 0);
  post({ ...BACK, extra: 'dropped' });
  assert.deepEqual(sent[0][1], BACK);
});

test('isRoomBackMessage validates type and version', () => {
  assert.equal(policy.isRoomBackMessage(BACK), true);
  for (const bad of [null, undefined, 'x', [], {}, { type: BACK.type }, { type: BACK.type, version: '1' }, { type: 'x', version: 1 }]) assert.equal(policy.isRoomBackMessage(bad), false);
});

function managerWithView() {
  const handlers = {}; let wc;
  class V { constructor() { this.visible = true; wc = this.webContents = { mainFrame: { url: '' }, setWindowOpenHandler() {}, on() {}, focus() {}, close() {}, loadURL: async () => {} }; } setBackgroundColor() {} setVisible(v) { this.visible = v; } getVisible() { return this.visible; } setBounds() {} }
  const ses = { cookies: { set: async () => {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, clearStorageData: async () => {}, clearCache: async () => {} };
  const win = { isDestroyed: () => false, getContentSize: () => [1, 1], on() {}, contentView: { addChildView() {}, removeChildView() {} } };
  let closed = 0;
  const rooms = createRoomManager({ electron: { WebContentsView: V, session: { fromPartition: () => ses } }, getWindow: () => win, onClosed: () => { closed++; } });
  return { rooms, wc: () => wc, closed: () => closed, handlers };
}

test('main validates the back message: wrong sender, frame, host, type or hidden room are ignored', async () => {
  const m = managerWithView();
  const open = () => m.rooms.open({ path: P1, url: `https://runtime-runner.singulancelabs.com${P1}?embed=hivemind`, getCookie: async () => ({ name: 'n', value: 'v', domain: null }) });
  await open();
  const top = { url: `https://runtime-runner.singulancelabs.com${P1}` };
  m.wc().mainFrame = top;
  const ev = (over = {}) => ({ sender: m.wc(), senderFrame: top, ...over });

  assert.equal(m.rooms.handleBack(ev({ sender: { mainFrame: top } }), BACK), false, 'another webContents (e.g. main window)');
  assert.equal(m.rooms.handleBack(ev({ senderFrame: { url: top.url } }), BACK), false, 'subframe');
  assert.equal(m.rooms.handleBack(ev({ senderFrame: Object.assign(m.wc().mainFrame, {}) && { url: 'https://evil.com/' } }), BACK), false, 'foreign host');
  m.wc().mainFrame = top;
  assert.equal(m.rooms.handleBack(ev(), { type: 'other', version: 1 }), false, 'wrong type');
  assert.equal(m.rooms.handleBack(ev(), { type: BACK.type, version: 2 }), false, 'wrong version');
  assert.equal(m.rooms.isOpen(), true); assert.equal(m.closed(), 0);

  assert.equal(m.rooms.handleBack(ev(), BACK), true);
  assert.equal(m.rooms.isOpen(), false); assert.equal(m.closed(), 1, 'renderer is told');
  assert.equal(m.rooms.handleBack(ev(), BACK), false, 'hidden room ignores it');
});

test('two-finger swipe right (accumulated leftward wheel deltas) sends the back message once; vertical or sideways-scrolling content does not', () => {
  const origCss = global.getComputedStyle;
  global.getComputedStyle = (el) => ({ overflowX: el.overflowX || 'visible' });
  try {
    const wheel = (deltaX, deltaY, target) => ({ deltaX, deltaY, target });
    const plain = { nodeType: 1, parentElement: null };
    const room = () => loadRoomPreload({ protocol: 'https:', hostname: 'runtime-runner.singulancelabs.com' });

    const a = room();
    for (let i = 0; i < 4; i++) a.listeners.wheel(wheel(-80, 2, plain));
    for (let i = 0; i < 4; i++) a.listeners.wheel(wheel(-80, 2, plain));
    assert.deepEqual(a.sent, [['native:room:back', BACK]], 'once per gesture');

    const b = room();
    for (let i = 0; i < 10; i++) b.listeners.wheel(wheel(-80, 90, plain));
    assert.deepEqual(b.sent, [], 'vertical scrolling');

    const c = room();
    for (let i = 0; i < 10; i++) c.listeners.wheel(wheel(80, 1, plain));
    assert.deepEqual(c.sent, [], 'swipe left');

    const d = room();
    const table = { nodeType: 1, parentElement: null, overflowX: 'auto', scrollWidth: 900, clientWidth: 300 };
    for (let i = 0; i < 10; i++) d.listeners.wheel(wheel(-80, 1, { nodeType: 1, parentElement: table }));
    assert.deepEqual(d.sent, [], 'a sideways-scrolling table keeps its own scroll');
  } finally { global.getComputedStyle = origCss; }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createRoomManager } = require('../src/native/room');

function fakeElectron() {
  const views = [];
  class WebContentsView {
    constructor() {
      this.visible = true; this.loads = [];
      this.webContents = { setWindowOpenHandler() {}, on() {}, loadURL: async (u) => { this.loads.push(u); }, focus() {}, close() {} };
      views.push(this);
    }
    setVisible(v) { this.visible = v; } getVisible() { return this.visible; } setBounds() {}
  }
  const ses = { cookies: { set: async () => {} }, setPermissionRequestHandler() {}, setPermissionCheckHandler() {}, clearStorageData: async () => {}, clearCache: async () => {} };
  const win = { isDestroyed: () => false, getContentSize: () => [800, 600], on() {}, contentView: { addChildView() {}, removeChildView() {} } };
  return { views, win, electron: { WebContentsView, session: { fromPartition: () => ses } } };
}

test('prewarm creates one hidden view that open() reuses and shows', async () => {
  const { views, win, electron } = fakeElectron();
  const rooms = createRoomManager({ electron, getWindow: () => win, onClosed() {} });
  await rooms.prewarm();
  assert.equal(views.length, 1);
  assert.equal(views[0].visible, false);
  assert.equal(rooms.isOpen(), false);
  await rooms.open('https://runtime-runner.singulancelabs.com/employees/x?embed=hivemind', { name: 'c', value: 'v', domain: null });
  assert.equal(views.length, 1, 'same view');
  assert.equal(views[0].visible, true);
  assert.equal(rooms.isOpen(), true);
});

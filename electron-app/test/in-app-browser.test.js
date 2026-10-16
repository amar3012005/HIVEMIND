const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createInAppBrowser } = require('../src/in-app-browser');

test('a cold managed window loads its renderer before attaching and enabling the private debugger', async () => {
  const calls = [];
  class Window extends EventEmitter {
    constructor(options) {
      super(); this.destroyed = false; let loaded = false; let url = '';
      this.webContents = new EventEmitter();
      Object.assign(this.webContents, {
        debugger: { attach: () => { assert.equal(loaded, true, 'Cold macOS transport needs its renderer first'); calls.push('attach'); },
          sendCommand: async method => { calls.push(method); return {}; } },
        loadURL: async value => { loaded = true; url = value; calls.push(value); },
        getURL: () => url, getTitle: () => 'Fixture', isDestroyed: () => this.destroyed,
        setWindowOpenHandler: handler => { this.openHandler = handler; }, stop: () => {},
      });
      assert.equal(options.webPreferences.nodeIntegration, false);
      assert.equal(options.webPreferences.sandbox, true);
      assert.equal(options.webPreferences.contextIsolation, true);
    }
    isDestroyed() { return this.destroyed; }
    destroy() { this.destroyed = true; this.emit('closed'); }
    showInactive() { calls.push('visible-without-focus'); }
    setTitle() {}
  }
  const profileSession = new EventEmitter();
  profileSession.setPermissionRequestHandler = () => {};
  profileSession.setPermissionCheckHandler = () => {};
  const client = createInAppBrowser({ BrowserWindow: Window,
    session: { fromPartition: name => { assert.match(name, /^persist:singulance-agent-/); return profileSession; } },
    dialog: { showMessageBox: async () => ({ response: 0 }) }, profile: { id: '12345678-1234-4234-8234-123456789abc' },
    getMainWindow: () => ({ isDestroyed: () => false }), authorize: async () => true });
  try {
    const result = await client.execute({ kind: 'browser.openUrl', url: 'https://fixture.invalid/' }, undefined, 'local-fixture-connection');
    assert.notEqual(result.isError, true);
    assert.ok(calls.indexOf('about:blank') < calls.indexOf('attach'));
    assert.ok(calls.indexOf('attach') < calls.indexOf('Page.enable'));
    assert.ok(calls.includes('visible-without-focus'));
  } finally { await client.close(); }
});

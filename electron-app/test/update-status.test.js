'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const { createUpdateStatus } = require('../src/native/update-status');

test('status is sent on change and replayed to a late subscriber', () => {
  const sent = [];
  const u = createUpdateStatus({ send: (d) => sent.push(d) });
  assert.deepEqual(u.get(), { status: 'idle' });
  u.set('checking');
  u.set('downloading', { percent: 40 });
  u.set('downloaded', { version: '2.3.0' });
  assert.deepEqual(sent.map((s) => s.status), ['checking', 'downloading', 'downloaded']);
  assert.deepEqual(u.get(), { status: 'downloaded', version: '2.3.0' }, 'late subscriber sees the latest');
  assert.equal(u.state(), 'downloaded');
  u.set('none');
  assert.deepEqual(u.get(), { status: 'none' }, 'old payload fields do not leak');
});

test('window.electron.getUpdateStatus invokes get-update-status', async () => {
  const exposed = {}; const calls = [];
  const fake = { contextBridge: { exposeInMainWorld: (n, v) => { exposed[n] = v; } }, ipcRenderer: { invoke: (c) => { calls.push(c); return Promise.resolve({ status: 'downloaded' }); }, on() {}, removeListener() {} } };
  const orig = Module._load; Module._load = (req, ...r) => (req === 'electron' ? fake : orig(req, ...r));
  try { delete require.cache[require.resolve('../src/preload.js')]; require('../src/preload.js'); } finally { Module._load = orig; }
  assert.deepEqual(await exposed.electron.getUpdateStatus(), { status: 'downloaded' });
  assert.deepEqual(calls, ['get-update-status']);
  for (const k of ['checkForUpdates', 'installUpdate', 'onUpdateStatus']) assert.equal(typeof exposed.electron[k], 'function');
});

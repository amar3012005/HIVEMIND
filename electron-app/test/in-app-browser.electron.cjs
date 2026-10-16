const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const { app, BrowserWindow, session } = require('electron');
const { createInAppBrowser } = require('../src/in-app-browser');

if (!process.versions.electron) throw new Error('Run this fixture with the actual Electron binary');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singulance-electron-fixture-'));
app.setPath('userData', directory);
app.setPath('sessionData', directory);
app.enableSandbox();
app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-dev-shm-usage');
const clients = [];
const diagnostics = [];
let parent;
let site;

app.whenReady().then(async () => {
  let passed = 0;
  try {
    site = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<title>Fixture</title><p id="count">Clicks:0</p><form onsubmit="event.preventDefault();document.querySelector(\'#submitted\').textContent=\'Submitted\'"><label>Name<input id="name" aria-label="Name"></label><button>Send</button></form><p id="submitted">Not submitted</p><button id="continue" onclick="document.querySelector(\'#count\').textContent=\'Clicks:1\'">Continue</button>');
    });
    site.listen(0, '127.0.0.1'); await once(site, 'listening');
    const url = `http://127.0.0.1:${site.address().port}/fixture`;
    parent = new BrowserWindow({ show: false, webPreferences: { sandbox: true, nodeIntegration: false, contextIsolation: true } });
    await parent.loadURL('about:blank');
    const profileA = { id: randomUUID(), name: 'SINGULANCE QA A' };
    const profileB = { id: randomUUID(), name: 'SINGULANCE QA B' };
    let allowed = true; let prompts = 0; let decision = async () => ({ response: 0 });
    const dialog = { showMessageBox: async (_parent, options) => { prompts++; return decision(options); } };
    const windowOptions = new Map();
    function ManagedWindow(options) { const window = new BrowserWindow(options); windowOptions.set(window.id, options); return window; }
    const clientA = createInAppBrowser({ BrowserWindow: ManagedWindow, session, dialog, profile: profileA, getMainWindow: () => parent, authorize: async () => allowed, onDiagnostic: value => diagnostics.push(value) });
    const clientB = createInAppBrowser({ BrowserWindow: ManagedWindow, session, dialog, profile: profileB, getMainWindow: () => parent, authorize: async () => allowed, onDiagnostic: value => diagnostics.push(value) });
    clients.push(clientA, clientB);
    const connectionA = randomUUID();
    const executeA = (operation, signal) => clientA.execute(operation, signal, connectionA);
    assert.equal((await executeA({ kind: 'browser.openUrl', url })).isError, undefined);
    const owned = BrowserWindow.getAllWindows().find(window => window !== parent);
    assert.ok(owned);
    const preferences = windowOptions.get(owned.id).webPreferences;
    assert.equal(await owned.webContents.executeJavaScript('typeof require'), 'undefined');
    assert.equal(await owned.webContents.executeJavaScript('typeof process'), 'undefined');
    assert.equal(preferences.sandbox, true); assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.contextIsolation, true);
    assert.equal(preferences.partition, `persist:singulance-agent-${profileA.id}`);
    assert.equal(app.commandLine.hasSwitch('remote-debugging-port'), false); passed++;

    await executeA({ kind: 'browser.typeText', field: 'Name', text: 'private-fixture-value', submit: false });
    assert.equal(await owned.webContents.executeJavaScript("document.querySelector('#name').value"), 'private-fixture-value');
    const click = await executeA({ kind: 'browser.clickText', text: 'Continue' });
    assert.equal(click.isError, undefined);
    const read = await executeA({ kind: 'browser.readPage' });
    assert.match(JSON.stringify(read), /Clicks:1/); assert.doesNotMatch(JSON.stringify(read), /private-fixture-value/); passed++;
    const submission = await executeA({ kind: 'browser.typeText', field: 'Name', text: 'private-fixture-value', submit: true });
    assert.equal(submission.isError, undefined);
    assert.equal(await owned.webContents.executeJavaScript("document.querySelector('#submitted').textContent"), 'Submitted'); passed++;

    const screenshot = await executeA({ kind: 'browser.screenshot' });
    const image = Buffer.from(screenshot.content[0].data, 'base64');
    assert.equal(image.readUInt32BE(16), 1280); assert.equal(image.readUInt32BE(20), 800);
    if (process.env.SINGULANCE_QA_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.SINGULANCE_QA_EVIDENCE_DIR, 'electron-managed-browser.png'), image);
    passed++;
    await owned.webContents.session.cookies.set({ url, name: 'fixture-isolation', value: 'A' });
    assert.equal((await session.defaultSession.cookies.get({ name: 'fixture-isolation' })).length, 0);
    await clientB.execute({ kind: 'browser.openUrl', url }, undefined, randomUUID());
    assert.equal((await session.fromPartition(`persist:singulance-agent-${profileB.id}`).cookies.get({ name: 'fixture-isolation' })).length, 0); passed++;

    await owned.webContents.loadURL(url);
    decision = async options => {
      if (options.title === 'Approve Browser Action?') allowed = false;
      return { response: 0 };
    };
    assert.equal((await executeA({ kind: 'browser.clickText', text: 'Continue' })).isError, true);
    allowed = true;
    assert.equal(await owned.webContents.executeJavaScript("document.querySelector('#count').textContent"), 'Clicks:0'); passed++;

    const controller = new AbortController();
    decision = async () => { controller.abort(new Error('cancelled real Electron action')); return { response: 0 }; };
    assert.equal((await executeA({ kind: 'browser.clickText', text: 'Continue' }, controller.signal)).isError, true);
    assert.equal(await owned.webContents.executeJavaScript("document.querySelector('#count').textContent"), 'Clicks:0'); passed++;
    decision = async () => ({ response: 0 });
    const beforeReconnect = prompts;
    await clientA.execute({ kind: 'browser.readPage' }, undefined, randomUUID());
    assert.equal(prompts, beforeReconnect + 1, 'A new authenticated connection asks for browser use again'); passed++;
    assert.equal((await executeA({ kind: 'browser.openUrl', url: 'file:///private/fixture' })).isError, true); passed++;
    await owned.webContents.executeJavaScript(`{
      const element=document.querySelector('#continue'); const bounds=element.getBoundingClientRect.bind(element); let calls=0;
      element.getBoundingClientRect=()=>{if(++calls===2){console.log('singulance-real-electron-stall');const end=performance.now()+3000;while(performance.now()<end){}}return bounds();};
      void 0;
    }`);
    const inFlight = new AbortController();
    const cancelStall = event => { if (event.message === 'singulance-real-electron-stall') inFlight.abort(new Error('cancelled in-flight Electron action')); };
    owned.webContents.on('console-message', cancelStall);
    const interrupted = await executeA({ kind: 'browser.clickText', text: 'Continue' }, inFlight.signal);
    assert.equal(interrupted.isError, true);
    if (!owned.isDestroyed()) {
      owned.webContents.removeListener('console-message', cancelStall);
      assert.equal(await owned.webContents.executeJavaScript("document.querySelector('#count').textContent"), 'Clicks:0');
    }
    passed++;
    const result = { status: 'passed', pid: process.pid, checkedAt: new Date().toISOString(), electron: process.versions.electron, chromium: process.versions.chrome, checks: passed,
      browser_renderer_sandbox: true, operating_system: process.platform, macos_mas_signature_acceptance: false };
    if (process.env.SINGULANCE_QA_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.SINGULANCE_QA_EVIDENCE_DIR, 'native-browser-smoke.json'), JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result));
  } finally {
    for (const client of clients) await client.close();
    if (parent && !parent.isDestroyed()) parent.destroy();
    if (site) { site.closeAllConnections(); await new Promise(resolve => site.close(resolve)); }
    fs.rmSync(directory, { recursive: true, force: true });
  }
  app.exit(0);
}).catch(error => {
  if (process.env.SINGULANCE_QA_EVIDENCE_DIR) fs.writeFileSync(path.join(process.env.SINGULANCE_QA_EVIDENCE_DIR, 'native-browser-smoke.json'), JSON.stringify({ status: 'failed', pid: process.pid, checkedAt: new Date().toISOString(), error: error.stack || error.message, diagnostics, electron: process.versions.electron, operating_system: process.platform }, null, 2) + '\n');
  console.error(error); app.exit(1);
});

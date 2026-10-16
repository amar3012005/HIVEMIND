import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const require = createRequire(import.meta.url);
const { createAgentProfile, browserPaths, startApprovalServer } = require('../src/managed-agent-browser');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

async function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'singulance-mcp-'));
  const profile = createAgentProfile({ userDataPath: directory, name: 'SINGULANCE QA' });
  let authorized = true;
  let consent = async () => ({ response: 0 });
  let usePrompts = 0;
  const approval = startApprovalServer({ userDataPath: directory, socketPath: path.join(directory, 'approval.sock'),
    dialog: { showMessageBox: async (...args) => {
      const options = args.at(-1);
      if (options.title === 'Allow agent browser access?') { usePrompts++; return { response: 0 }; }
      return consent(options);
    } }, authorizeAction: async () => authorized,
    log: { error: () => {} } });
  await approval.ready;
  const site = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html' });
    response.end('<p id="count">Click count:0</p><button onclick="document.querySelector(\'#count\').textContent=\'Click count:1\'">Continue</button>');
  });
  site.listen(0, '127.0.0.1'); await once(site, 'listening');
  const url = `http://127.0.0.1:${site.address().port}/fixture`;
  let client;
  let transport;
  async function connect() {
    transport = new StdioClientTransport({ command: process.execPath,
      args: [path.join(root, 'src/agent-browser-mcp.mjs'), '--home', browserPaths(directory).root,
        '--profile-id', profile.id, '--approval-socket', approval.socketPath],
      cwd: directory, stderr: 'pipe',
      env: { PATH: process.env.PATH, HOME: directory, DISPLAY: process.env.DISPLAY,
        ...(process.env.XAUTHORITY ? { XAUTHORITY: process.env.XAUTHORITY } : {}),
        PLAYWRIGHT_BROWSERS_PATH: process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/playwright' } });
    transport.stderr?.on('data', () => {});
    client = new Client({ name: 'singulance-browser-qa', version: '1.0.0' }, { capabilities: {} });
    await client.connect(transport);
  }
  await connect();
  const call = (operation, signal) => client.callTool({ name: 'browser_execute_owned', arguments: { operation } }, undefined, { timeout: 15000, ...(signal ? { signal } : {}) });
  return { directory, url, call,
    consent: callback => { consent = callback; }, authorize: value => { authorized = value; },
    usePrompts: () => usePrompts,
    snapshot: async () => JSON.stringify(await client.callTool({ name: 'browser_snapshot', arguments: {} }, undefined, { timeout: 15000 })),
    restart: async () => { await client.close(); await connect(); },
    close: async () => {
      try { await client.close(); } finally {
        approval.close(); site.closeAllConnections(); await new Promise(resolve => site.close(resolve));
        fs.rmSync(directory, { recursive: true, force: true });
      }
    } };
}

test('actual MCP cancellation during pending native consent blocks late approved mutations and reconnect asks again', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    assert.equal((await f.call({ kind: 'browser.openUrl', url: f.url })).isError, undefined);
    assert.equal(f.usePrompts(), 1);
    let entered; const pending = new Promise(resolve => { entered = resolve; });
    let release; const answer = new Promise(resolve => { release = resolve; });
    f.consent(async () => { entered(); return answer; });
    const controller = new AbortController();
    const action = f.call({ kind: 'browser.clickText', text: 'Continue' }, controller.signal);
    const rejected = assert.rejects(action);
    await pending; controller.abort(new Error('cancelled fixture request')); release({ response: 0 });
    await rejected;
    assert.match(await f.snapshot(), /Click count:0/);
    f.consent(async () => ({ response: 0 }));
    await f.restart();
    assert.equal((await f.call({ kind: 'browser.openUrl', url: f.url })).isError, undefined);
    assert.equal(f.usePrompts(), 2);
    assert.match(await f.snapshot(), /Click count:0/);
  } finally { await f.close(); }
});

test('actual MCP worker denies a browser mutation when native authority is revoked during consent', { timeout: 60000 }, async () => {
  const f = await fixture();
  try {
    await f.call({ kind: 'browser.openUrl', url: f.url });
    f.consent(async () => { f.authorize(false); return { response: 0 }; });
    const result = await f.call({ kind: 'browser.clickText', text: 'Continue' });
    assert.equal(result.isError, true);
    f.authorize(true);
    assert.match(await f.snapshot(), /Click count:0/);
  } finally { await f.close(); }
});

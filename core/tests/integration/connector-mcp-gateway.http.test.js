// Connector Runtime V1 — HTTP wire-level integration test of the MCP gateway.
//
// Proves tool-calling accuracy END-TO-END over a real TCP socket (not just
// in-process handler calls): a real node http server wraps the capability +
// gateway handlers; the test issues a capability token via the capability
// endpoint, then drives the MCP JSON-RPC lifecycle (initialize → tools/list →
// tools/call) over real HTTP, asserting the Gmail read returns the exact legacy
// payload. This is the same wire protocol (JSON-RPC over streamable-HTTP POST,
// proto 2025-11-25) the Phase-1 AgentScope 1.0.21 HttpStatelessClient spoke.

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { generateKeyPairSync } from 'node:crypto';

import { _setKeys } from '../../src/connectors/runtime/capability-token.js';
import { handleCapabilityRequest, handleGatewayRequest } from '../../src/connectors/runtime/mcp-routes.js';
import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { ConnectorRuntime } from '../../src/connectors/runtime/connector-runtime.js';
import { GmailPlugin } from '../../src/connectors/runtime/plugins/gmail/index.js';
import { loadRuntimeConfig } from '../../src/connectors/runtime/config.js';
import { buildDefaultHooks } from '../../src/connectors/runtime/index.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
_setKeys({ privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });

const GMAIL_SEARCH = { count: 2, messages: [{ id: 'm1', subject: 'Q3' }, { id: 'm2', subject: 'Lunch' }] };
const execCalls = [];
function buildRuntime() {
  const exec = async (tool, args, scope) => { execCalls.push({ tool, args, scope }); return GMAIL_SEARCH; };
  const reg = new ConnectorRegistry();
  reg.register(new GmailPlugin({ execGoogleTool: exec }));
  const config = loadRuntimeConfig({ CONNECTOR_RUNTIME_ENABLED: '1', CONNECTOR_RUNTIME_MCP: '1', CONNECTOR_RUNTIME_HYPER: '1' });
  return new ConnectorRuntime({ registry: reg, config, db: {}, hooks: buildDefaultHooks({}) });
}

let server; let base; let runtime;

before(async () => {
  runtime = buildRuntime();
  // Minimal HTTP shim mirroring what the server.js mount will do (flag-gated).
  server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', async () => {
      const body = raw ? JSON.parse(raw) : {};
      const send = (status, obj) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(obj === null ? '' : JSON.stringify(obj)); };
      try {
        if (req.url === '/api/connectors/runtime/capabilities') {
          // principal is the authenticated master/session caller (simulated here)
          const r = handleCapabilityRequest({ body, principal: { userId: 'u1', orgId: 'o1', role: 'member' }, runtime });
          return send(r.status, r.body);
        }
        const m = /^\/mcp\/connectors\/([^/?]+)/.exec(req.url);
        if (m) {
          const r = await handleGatewayRequest({ connectorId: m[1], authHeader: req.headers.authorization, request: body, runtime });
          return send(r.status, r.body);
        }
        return send(404, { error: 'not found' });
      } catch (e) { return send(500, { error: e.message }); }
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => { server && server.close(); });

async function post(path, body, headers = {}) {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

test('E2E over real HTTP: issue capability → initialize → tools/list → tools/call(gmail read)', async () => {
  // 1. issue a capability token via the capability endpoint
  const cap = await post('/api/connectors/runtime/capabilities', { surface: 'hyperagents', requested_connectors: ['gmail'], requested_access: 'read' });
  assert.equal(cap.status, 200);
  const token = cap.json.capability_token;
  assert.ok(token, 'capability token issued');
  assert.equal(cap.json.connectors[0].endpoint, '/mcp/connectors/gmail');
  const auth = { authorization: `Bearer ${token}` };

  // 2. initialize
  const init = await post('/mcp/connectors/gmail', { jsonrpc: '2.0', id: 1, method: 'initialize' }, auth);
  assert.equal(init.status, 200);
  assert.equal(init.json.result.protocolVersion, '2025-11-25');

  // 3. tools/list — only granted read tools
  const list = await post('/mcp/connectors/gmail', { jsonrpc: '2.0', id: 2, method: 'tools/list' }, auth);
  assert.equal(list.status, 200);
  const names = list.json.result.tools.map((t) => t.name);
  assert.ok(names.includes('gmail__search'));
  assert.ok(!names.includes('gmail__send'), 'read grant hides writes over the wire');

  // 4. tools/call — the Gmail read returns the exact legacy payload
  execCalls.length = 0;
  const call = await post('/mcp/connectors/gmail', { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'gmail__search', arguments: { query: 'from:a' } } }, auth);
  assert.equal(call.status, 200);
  assert.equal(call.json.result.isError, false);
  const payload = JSON.parse(call.json.result.content[0].text);
  assert.deepEqual(payload, GMAIL_SEARCH, 'tool-calling accuracy: wire result == legacy payload');
  // identity came from the token, not the request
  assert.deepEqual(execCalls[0].scope, { user_id: 'u1', org_id: 'o1' });
});

test('E2E over HTTP: missing bearer → 401', async () => {
  const r = await post('/mcp/connectors/gmail', { jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.equal(r.status, 401);
});

test('E2E over HTTP: a write tool under a read capability is refused (not executed)', async () => {
  const cap = await post('/api/connectors/runtime/capabilities', { surface: 'hyperagents', requested_connectors: ['gmail'], requested_access: 'read' });
  const auth = { authorization: `Bearer ${cap.json.capability_token}` };
  execCalls.length = 0;
  const call = await post('/mcp/connectors/gmail', { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'gmail__send', arguments: { to: 'a@x.com', subject: 's', body: 'b' } } }, auth);
  assert.equal(call.json.result.isError, true);
  assert.equal(call.json.result._meta.status, 'forbidden');
  assert.equal(execCalls.length, 0, 'write not executed under read capability');
});

// Connector Runtime V1 — Phase 5b: capability endpoint + gateway route handlers.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { _setKeys } from '../../src/connectors/runtime/capability-token.js';
import { handleCapabilityRequest, handleGatewayRequest } from '../../src/connectors/runtime/mcp-routes.js';
import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { ConnectorRuntime } from '../../src/connectors/runtime/connector-runtime.js';
import { GmailPlugin } from '../../src/connectors/runtime/plugins/gmail/index.js';
import { createGoogleDocsPlugin } from '../../src/connectors/runtime/plugins/google_docs/index.js';
import { loadRuntimeConfig } from '../../src/connectors/runtime/config.js';
import { buildDefaultHooks } from '../../src/connectors/runtime/index.js';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
_setKeys({ privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });

function runtime({ mcp = true } = {}) {
  const exec = async (t, a, scope) => ({ ok: true, tool: t, scope });
  const reg = new ConnectorRegistry();
  reg.register(new GmailPlugin({ execGoogleTool: exec }));
  reg.register(createGoogleDocsPlugin({ execGoogleTool: exec }));
  // a hyperagents capability is gated by the HYPER surface flag; the gateway
  // transport by MCP. Enable the surfaces this suite exercises.
  const on = mcp ? '1' : '';
  const config = loadRuntimeConfig({
    CONNECTOR_RUNTIME_ENABLED: on,
    CONNECTOR_RUNTIME_MCP: on,
    CONNECTOR_RUNTIME_HYPER: on,
    CONNECTOR_RUNTIME_TARA: on,
  });
  return new ConnectorRuntime({ registry: reg, config, db: {}, hooks: buildDefaultHooks({}) });
}

const PRINCIPAL = { userId: 'u1', orgId: 'o1', role: 'member' };

test('capability: unauthenticated → 401', () => {
  const r = handleCapabilityRequest({ body: { surface: 'hyperagents' }, principal: null, runtime: runtime() });
  assert.equal(r.status, 401);
});

test('capability: bad surface → 400', () => {
  const r = handleCapabilityRequest({ body: { surface: 'chat' }, principal: PRINCIPAL, runtime: runtime() });
  assert.equal(r.status, 400); // chat is in-process, not a remote MCP surface
});

test('capability: issues token + connector list (intersection of requested + registered + enabled)', () => {
  const r = handleCapabilityRequest({ body: { surface: 'hyperagents', requested_connectors: ['gmail', 'notion'], requested_access: 'read' }, principal: PRINCIPAL, runtime: runtime() });
  assert.equal(r.status, 200);
  assert.ok(r.body.capability_token);
  assert.ok(r.body.expires_at);
  const ids = r.body.connectors.map((c) => c.id);
  assert.deepEqual(ids, ['gmail']); // notion not registered → filtered out
  assert.equal(r.body.connectors[0].endpoint, '/mcp/connectors/gmail');
  assert.ok(r.body.connectors[0].tool_count > 0);
});

test('capability: read grant reports only read tool_count', () => {
  const rRead = handleCapabilityRequest({ body: { surface: 'hyperagents', requested_connectors: ['gmail'], requested_access: 'read' }, principal: PRINCIPAL, runtime: runtime() });
  const rWrite = handleCapabilityRequest({ body: { surface: 'hyperagents', requested_connectors: ['gmail'], requested_access: 'write' }, principal: PRINCIPAL, runtime: runtime() });
  const readCount = rRead.body.connectors[0].tool_count;
  const writeCount = rWrite.body.connectors[0].tool_count;
  assert.ok(writeCount > readCount, 'write grant exposes more tools than read');
});

test('capability: disabled config → 403 (flag off)', () => {
  const r = handleCapabilityRequest({ body: { surface: 'hyperagents', requested_connectors: ['gmail'] }, principal: PRINCIPAL, runtime: runtime({ mcp: false }) });
  assert.equal(r.status, 403);
});

test('gateway: missing bearer → 401', async () => {
  const r = await handleGatewayRequest({ connectorId: 'gmail', authHeader: '', request: { jsonrpc: '2.0', id: 1, method: 'tools/list' }, runtime: runtime() });
  assert.equal(r.status, 401);
  assert.ok(r.body.error.message.includes('bearer'));
});

test('gateway: valid token → tools/list works end-to-end (issue → call)', async () => {
  const rt = runtime();
  const cap = handleCapabilityRequest({ body: { surface: 'hyperagents', requested_connectors: ['gmail'], requested_access: 'read' }, principal: PRINCIPAL, runtime: rt });
  const r = await handleGatewayRequest({
    connectorId: 'gmail',
    authHeader: `Bearer ${cap.body.capability_token}`,
    request: { jsonrpc: '2.0', id: 7, method: 'tools/list' },
    runtime: rt,
  });
  assert.equal(r.status, 200);
  const names = r.body.result.tools.map((t) => t.name);
  assert.ok(names.includes('gmail__search'));
  assert.ok(!names.includes('gmail__send'), 'read grant hides writes');
});

test('gateway: token for gmail cannot call google_docs endpoint', async () => {
  const rt = runtime();
  const cap = handleCapabilityRequest({ body: { surface: 'hyperagents', requested_connectors: ['gmail'], requested_access: 'read' }, principal: PRINCIPAL, runtime: rt });
  const r = await handleGatewayRequest({
    connectorId: 'google_docs',
    authHeader: `Bearer ${cap.body.capability_token}`,
    request: { jsonrpc: '2.0', id: 8, method: 'tools/list' },
    runtime: rt,
  });
  assert.equal(r.status, 200); // JSON-RPC error is carried in body, HTTP 200
  assert.ok(r.body.error, 'connector not granted → jsonrpc error');
});

test('gateway: notification → 202 no body', async () => {
  const rt = runtime();
  const cap = handleCapabilityRequest({ body: { surface: 'hyperagents', requested_connectors: ['gmail'] }, principal: PRINCIPAL, runtime: rt });
  const r = await handleGatewayRequest({
    connectorId: 'gmail',
    authHeader: `Bearer ${cap.body.capability_token}`,
    request: { jsonrpc: '2.0', method: 'notifications/initialized' },
    runtime: rt,
  });
  assert.equal(r.status, 202);
  assert.equal(r.body, null);
});

test('gateway: revoked token → 401', async () => {
  const rt = runtime();
  const cap = handleCapabilityRequest({ body: { surface: 'hyperagents', requested_connectors: ['gmail'] }, principal: PRINCIPAL, runtime: rt });
  const r = await handleGatewayRequest({
    connectorId: 'gmail',
    authHeader: `Bearer ${cap.body.capability_token}`,
    request: { jsonrpc: '2.0', id: 9, method: 'tools/list' },
    runtime: rt,
    isRevoked: async () => true,
  });
  assert.equal(r.status, 401);
});

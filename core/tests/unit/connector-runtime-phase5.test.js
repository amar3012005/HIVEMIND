// Connector Runtime V1 — Phase 5 tests: capability token + MCP gateway.
// plan §8 Phase 5 acceptance: list only granted tools; wrong org/surface/expired/
// revoked fail; tool call reaches the same runtime function as direct calls.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';

import { mintCapabilityToken, verifyCapabilityToken, _setKeys, makeRevocationStore, CAPABILITY_AUDIENCE } from '../../src/connectors/runtime/capability-token.js';
import { handleMcpRequest, canonicalResultToMcp, MCP_PROTOCOL_VERSION } from '../../src/connectors/runtime/mcp-gateway.js';
import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { ConnectorRuntime } from '../../src/connectors/runtime/connector-runtime.js';
import { GmailPlugin } from '../../src/connectors/runtime/plugins/gmail/index.js';
import { buildDefaultHooks } from '../../src/connectors/runtime/index.js';

// deterministic keypair for the whole suite
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
_setKeys({ privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }), publicKey: publicKey.export({ type: 'spki', format: 'pem' }) });

const GRANT = { userId: 'u1', orgId: 'o1', role: 'member', surface: 'hyperagents', connectors: ['gmail'], access: 'read', projectIds: ['p1'] };

// ── Token ────────────────────────────────────────────────────────────────
test('mint + verify round-trips with correct claims', async () => {
  const { token, jti } = mintCapabilityToken(GRANT);
  const v = await verifyCapabilityToken(token);
  assert.equal(v.valid, true);
  assert.equal(v.claims.sub, 'u1');
  assert.equal(v.claims.org, 'o1');
  assert.equal(v.claims.aud, CAPABILITY_AUDIENCE);
  assert.equal(v.claims.jti, jti);
  assert.deepEqual(v.claims.connectors, ['gmail']);
});

test('expired token fails', async () => {
  const { token } = mintCapabilityToken({ ...GRANT, ttlSec: 30 }, { now: () => 0 });
  const v = await verifyCapabilityToken(token, { now: () => 60_000 });
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'expired');
});

test('tampered payload fails signature', async () => {
  const { token } = mintCapabilityToken(GRANT);
  const [h, p, s] = token.split('.');
  const forged = JSON.parse(Buffer.from(p, 'base64url').toString());
  forged.org = 'evil-org';
  const tampered = `${h}.${Buffer.from(JSON.stringify(forged)).toString('base64url')}.${s}`;
  const v = await verifyCapabilityToken(tampered);
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'bad_signature');
});

test('surface mismatch rejected', async () => {
  const { token } = mintCapabilityToken(GRANT);
  const v = await verifyCapabilityToken(token, { expectedSurface: 'tara' });
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'surface_mismatch');
});

test('revoked JTI fails (Redis denylist)', async () => {
  const store = new Map();
  const redis = { async set(k) { store.set(k, '1'); }, async get(k) { return store.get(k) || null; } };
  const rev = makeRevocationStore(redis);
  const { token, jti } = mintCapabilityToken(GRANT);
  assert.equal((await verifyCapabilityToken(token, { isRevoked: rev.isRevoked })).valid, true);
  await rev.revoke(jti);
  const v = await verifyCapabilityToken(token, { isRevoked: rev.isRevoked });
  assert.equal(v.valid, false);
  assert.equal(v.reason, 'revoked');
});

test('Redis down during revocation check → token still validates (degrade)', async () => {
  const rev = makeRevocationStore({ async get() { throw new Error('redis down'); } });
  const { token } = mintCapabilityToken(GRANT);
  const v = await verifyCapabilityToken(token, { isRevoked: rev.isRevoked });
  assert.equal(v.valid, true); // cannot check → continue
});

// ── Gateway ────────────────────────────────────────────────────────────────
function gatewayRuntime() {
  const calls = [];
  const exec = async (tool, args, scope) => { calls.push({ tool, args, scope }); return { count: 1, messages: [{ id: 'm1' }] }; };
  const reg = new ConnectorRegistry();
  reg.register(new GmailPlugin({ execGoogleTool: exec }));
  const runtime = new ConnectorRuntime({ registry: reg, db: {}, hooks: buildDefaultHooks({}) });
  return { runtime, calls };
}

test('initialize returns the negotiated protocol version', async () => {
  const { runtime } = gatewayRuntime();
  const res = await handleMcpRequest({ connectorId: 'gmail', request: { jsonrpc: '2.0', id: 1, method: 'initialize' }, claims: mintClaims(), runtime });
  assert.equal(res.result.protocolVersion, MCP_PROTOCOL_VERSION);
});

function mintClaims(over = {}) {
  return { sub: 'u1', org: 'o1', role: 'member', surface: 'hyperagents', connectors: ['gmail'], access: 'read', projects: ['p1'], jti: 'j1', ...over };
}

test('tools/list returns ONLY granted-connector read tools (read grant hides writes)', async () => {
  const { runtime } = gatewayRuntime();
  const res = await handleMcpRequest({ connectorId: 'gmail', request: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, claims: mintClaims(), runtime });
  const names = res.result.tools.map((t) => t.name);
  assert.ok(names.includes('gmail__search'));
  assert.ok(!names.some((n) => ['gmail__send', 'gmail__create_draft', 'gmail__send_draft'].includes(n)), 'read grant must not expose write tools');
});

test('tools/list for a non-granted connector → error', async () => {
  const { runtime } = gatewayRuntime();
  const res = await handleMcpRequest({ connectorId: 'notion', request: { jsonrpc: '2.0', id: 3, method: 'tools/list' }, claims: mintClaims(), runtime });
  assert.ok(res.error);
  assert.equal(res.error.code, -32001);
});

test('tools/call reaches the runtime (same function as direct) and returns MCP content', async () => {
  const { runtime, calls } = gatewayRuntime();
  const res = await handleMcpRequest({ connectorId: 'gmail', request: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'gmail__search', arguments: { query: 'x' } } }, claims: mintClaims(), runtime });
  assert.equal(res.result.isError, false);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].tool, 'gmail_search');
  assert.deepEqual(calls[0].scope, { user_id: 'u1', org_id: 'o1' }); // identity from claims, not request
});

test('tools/call for a tool outside the URL connector → error', async () => {
  const { runtime } = gatewayRuntime();
  const res = await handleMcpRequest({ connectorId: 'gmail', request: { jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'notion__search', arguments: {} } }, claims: mintClaims({ connectors: ['gmail', 'notion'] }), runtime });
  assert.ok(res.error);
  assert.equal(res.error.code, -32602);
});

test('read-capability calling a write tool → runtime forbids it', async () => {
  const { runtime, calls } = gatewayRuntime();
  // even though read grant hides writes in tools/list, a hostile client may still call one
  const res = await handleMcpRequest({ connectorId: 'gmail', request: { jsonrpc: '2.0', id: 6, method: 'tools/call', params: { name: 'gmail__send', arguments: { to: 'a@x.com', subject: 's', body: 'b' } } }, claims: mintClaims(), runtime });
  assert.equal(res.result.isError, true);
  assert.equal(res.result._meta.status, 'forbidden');
  assert.equal(calls.length, 0, 'write must not execute under a read capability');
});

test('notifications get no response', async () => {
  const { runtime } = gatewayRuntime();
  const res = await handleMcpRequest({ connectorId: 'gmail', request: { jsonrpc: '2.0', method: 'notifications/initialized' }, claims: mintClaims(), runtime });
  assert.equal(res, null);
});

test('canonicalResultToMcp maps status to isError', () => {
  assert.equal(canonicalResultToMcp({ status: 'completed', content: [{ type: 'text', text: 'ok' }] }).isError, false);
  assert.equal(canonicalResultToMcp({ status: 'not_connected', content: [] }).isError, true);
  const appr = canonicalResultToMcp({ status: 'approval_required', content: [], approval: { id: 'a1' } });
  assert.equal(appr.isError, false);
  assert.equal(appr._meta.approval.id, 'a1');
});

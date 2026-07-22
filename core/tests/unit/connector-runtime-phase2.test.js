// Connector Runtime V1 — Phase 2 acceptance tests.
//
// Covers plan §8 Phase 2 acceptance + §9 relevant cases, with NO network / no
// DB / no OAuth (Gmail plugin's provider executor is injected):
//   - canonical schemas match characterization fixtures (names/shapes)
//   - runtime direct execution equals the legacy result (parity)
//   - cross-tenant / surface / unknown-tool calls fail structurally
//   - runtime adds no material latency
//   - contract + registry + alias + truncation + error-classification invariants

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  validateManifest,
  validateToolContract,
  TOOL_NAME_RE,
  parseToolName,
  makeResult,
} from '../../src/connectors/runtime/contracts.js';
import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { ConnectorRuntime } from '../../src/connectors/runtime/connector-runtime.js';
import { ConnectorPlugin } from '../../src/connectors/runtime/connector-plugin.js';
import { GmailPlugin, GMAIL_MANIFEST } from '../../src/connectors/runtime/plugins/gmail/index.js';
import { loadRuntimeConfig } from '../../src/connectors/runtime/config.js';

const CTX = (over = {}) => ({ requestId: 'r1', userId: 'u1', orgId: 'o1', role: 'member', surface: 'chat', ...over });

// A fake runGoogleTool: records (tool,args,scope) and returns canned payloads
// identical in shape to google-native's real returns.
function fakeGoogle(payloads) {
  const calls = [];
  const fn = async (tool, args, scope /*, db */) => {
    calls.push({ tool, args, scope });
    if (payloads[tool] instanceof Error) throw payloads[tool];
    if (typeof payloads[tool] === 'function') return payloads[tool](args, scope);
    if (!(tool in payloads)) throw new Error(`unexpected tool ${tool}`);
    return payloads[tool];
  };
  fn.calls = calls;
  return fn;
}

const SEARCH_PAYLOAD = {
  count: 2,
  messages: [
    { id: 'm1', threadId: 't1', subject: 'Q3 plan', from: 'a@x.com', to: 'me@x.com', date: 'Mon', snippet: 'hello' },
    { id: 'm2', threadId: 't2', subject: 'Lunch', from: 'b@x.com', to: 'me@x.com', date: 'Tue', snippet: 'noon?' },
  ],
};

function buildRuntime(payloads, { config } = {}) {
  const exec = fakeGoogle(payloads);
  const registry = new ConnectorRegistry();
  registry.register(new GmailPlugin({ execGoogleTool: exec }));
  const runtime = new ConnectorRuntime({ registry, config: config || null, db: { fake: true } });
  return { runtime, exec, registry };
}

// ── Contracts ──────────────────────────────────────────────────────────
test('canonical tool-name regex accepts <connector>__<operation>, rejects bad names', () => {
  assert.ok(TOOL_NAME_RE.test('gmail__search'));
  assert.ok(TOOL_NAME_RE.test('google_docs__get'));
  assert.ok(!TOOL_NAME_RE.test('gmail_search'));   // single underscore, no op
  assert.ok(!TOOL_NAME_RE.test('Gmail__Search'));  // uppercase
  assert.ok(!TOOL_NAME_RE.test('gmail__'));         // empty op
  assert.ok(!TOOL_NAME_RE.test('__search'));        // empty connector
  assert.deepEqual(parseToolName('gmail__get_thread'), { connector: 'gmail', operation: 'get_thread' });
});

test('validateManifest accepts the Gmail manifest and freezes tools', () => {
  const m = validateManifest(GMAIL_MANIFEST);
  assert.equal(m.id, 'gmail');
  assert.equal(m.tools.length, 5);
  assert.ok(Object.isFrozen(m.tools));
  assert.ok(m.tools.every((t) => t.access === 'read' && t.approval === 'never'));
});

test('validateToolContract rejects destructive tool without approval', () => {
  assert.throws(() => validateToolContract({
    name: 'x__nuke', description: 'd', inputSchema: { type: 'object' },
    access: 'write', approval: 'never', destructive: true,
  }, { connectorId: 'x' }), /must have approval:'required'/);
});

test('validateToolContract rejects tool whose prefix != connector id', () => {
  assert.throws(() => validateToolContract({
    name: 'slack__post', description: 'd', inputSchema: { type: 'object' }, access: 'read', approval: 'never',
  }, { connectorId: 'gmail' }), /prefix must equal connector id/);
});

// ── Registry + aliases ───────────────────────────────────────────────────
test('registry resolves canonical AND legacy names to the same tool', () => {
  const { registry } = buildRuntime({});
  const a = registry.resolveTool('gmail__search');
  const b = registry.resolveTool('gmail_search'); // legacy alias auto-registered
  assert.ok(a && b);
  assert.equal(a.canonicalName, 'gmail__search');
  assert.equal(b.canonicalName, 'gmail__search');
  assert.equal(b.connectorId, 'gmail');
});

test('registry rejects duplicate connector registration', () => {
  const { registry } = buildRuntime({});
  assert.throws(() => registry.register(new GmailPlugin({ execGoogleTool: async () => ({}) })), /already registered/);
});

// ── Execution parity ───────────────────────────────────────────────────
test('runtime executeTool(gmail__search) returns the legacy payload verbatim', async () => {
  const { runtime, exec } = buildRuntime({ gmail_search: SEARCH_PAYLOAD });
  const res = await runtime.executeTool('gmail__search', { query: 'from:a', max: 5 }, CTX());
  assert.equal(res.status, 'completed');
  // parity: the json content data deep-equals what the legacy executor returned
  assert.equal(res.content[0].type, 'json');
  assert.deepEqual(res.content[0].data, SEARCH_PAYLOAD);
  // legacy executor was called with the mapped legacy name + caller-scoped identity
  assert.equal(exec.calls[0].tool, 'gmail_search');
  assert.deepEqual(exec.calls[0].scope, { user_id: 'u1', org_id: 'o1' });
  // sourceIds surfaced for citation
  assert.deepEqual(res.metadata.sourceIds, ['m1', 'm2']);
  assert.equal(res.metadata.connector, 'gmail');
  assert.equal(res.metadata.tool, 'gmail__search');
});

test('legacy tool name routes through the runtime identically', async () => {
  const { runtime } = buildRuntime({ gmail_search: SEARCH_PAYLOAD });
  const res = await runtime.executeTool('gmail_search', { query: 'x' }, CTX());
  assert.equal(res.status, 'completed');
  assert.deepEqual(res.content[0].data, SEARCH_PAYLOAD);
});

// ── Security / structural failures ─────────────────────────────────────
test('cross-tenant: identity comes from ctx, never from tool args', async () => {
  const { runtime, exec } = buildRuntime({ gmail_search: SEARCH_PAYLOAD });
  // model tries to smuggle another user via args — must be ignored
  await runtime.executeTool('gmail__search', { query: 'x', user_id: 'victim', org_id: 'other' }, CTX());
  assert.deepEqual(exec.calls[0].scope, { user_id: 'u1', org_id: 'o1' });
});

test('unknown tool → invalid_input (never throws)', async () => {
  const { runtime } = buildRuntime({});
  const res = await runtime.executeTool('gmail__frobnicate', {}, CTX());
  assert.equal(res.status, 'invalid_input');
});

test('surface not allowed → forbidden', async () => {
  const { runtime } = buildRuntime({ gmail_search: SEARCH_PAYLOAD });
  // gmail reads are not allowed on the "sync" surface
  const res = await runtime.executeTool('gmail__search', { query: 'x' }, CTX({ surface: 'sync' }));
  assert.equal(res.status, 'forbidden');
});

test('not-connected provider error → not_connected status', async () => {
  const { runtime } = buildRuntime({ gmail_search: new Error('gmail not connected for this user — connect it on the Connectors page') });
  const res = await runtime.executeTool('gmail__search', { query: 'x' }, CTX());
  assert.equal(res.status, 'not_connected');
});

test('401 provider error → reauth_required', async () => {
  const { runtime } = buildRuntime({ gmail_get: new Error('Google API 401: invalid credentials') });
  const res = await runtime.executeTool('gmail__get_message', { id: 'm1' }, CTX());
  assert.equal(res.status, 'reauth_required');
});

test('429 provider error → rate_limited', async () => {
  const { runtime } = buildRuntime({ gmail_get: new Error('Google API 429: rate limit exceeded') });
  const res = await runtime.executeTool('gmail__get_message', { id: 'm1' }, CTX());
  assert.equal(res.status, 'rate_limited');
});

test('secrets are redacted from error output', async () => {
  const { runtime } = buildRuntime({ gmail_get: new Error('failed with Authorization: Bearer ya29.SECRETTOKEN123 boom') });
  const res = await runtime.executeTool('gmail__get_message', { id: 'm1' }, CTX());
  const text = JSON.stringify(res);
  assert.ok(!text.includes('ya29.SECRETTOKEN123'), 'token must be redacted');
  assert.ok(text.includes('[redacted]'));
});

// ── Truncation ──────────────────────────────────────────────────────────
test('oversized result is truncated with truncated=true', async () => {
  const big = { count: 1, messages: [{ id: 'm1', snippet: 'x'.repeat(50_000) }] };
  const { runtime } = buildRuntime({ gmail_search: big });
  const res = await runtime.executeTool('gmail__search', { query: 'x' }, CTX());
  assert.equal(res.status, 'completed');
  assert.equal(res.metadata.truncated, true);
  assert.ok(res.metadata.resultBytes <= 32 * 1024);
});

// ── Latency ────────────────────────────────────────────────────────────
test('runtime overhead over the legacy executor is < 20ms', async () => {
  const { runtime } = buildRuntime({ gmail_search: SEARCH_PAYLOAD });
  const N = 50;
  const t0 = Date.now();
  for (let i = 0; i < N; i++) await runtime.executeTool('gmail__search', { query: 'x' }, CTX());
  const perCall = (Date.now() - t0) / N;
  assert.ok(perCall < 20, `per-call overhead ${perCall.toFixed(2)}ms should be < 20ms`);
});

// ── Deadline ────────────────────────────────────────────────────────────
test('a hung provider call hits the deadline → timeout status (never hangs)', async () => {
  // A purpose-built plugin declaring a short deadline; its tool never resolves.
  const HANG_MANIFEST = {
    id: 'hang', version: '1.0.0', displayName: 'Hang', authProvider: 'none', syncMode: 'none',
    tools: [{
      name: 'hang__forever', description: 'never returns', inputSchema: { type: 'object' },
      access: 'read', approval: 'never', timeoutMs: 50, allowedSurfaces: ['chat'],
    }],
  };
  class HangPlugin extends ConnectorPlugin {
    constructor() { super(HANG_MANIFEST); }
    async executeTool() { return new Promise(() => {}); } // never resolves
  }
  const registry = new ConnectorRegistry();
  registry.register(new HangPlugin());
  const runtime = new ConnectorRuntime({ registry, db: {} });
  const res = await runtime.executeTool('hang__forever', {}, CTX());
  assert.equal(res.status, 'timeout');
});

// ── Config gating ────────────────────────────────────────────────────────
test('config disabled by default blocks execution on a flagged surface', async () => {
  const config = loadRuntimeConfig({}); // all flags off
  const { runtime } = buildRuntime({ gmail_search: SEARCH_PAYLOAD }, { config });
  const res = await runtime.executeTool('gmail__search', { query: 'x' }, CTX());
  assert.equal(res.status, 'forbidden'); // runtime not enabled for surface
});

test('config enabled for chat + gmail allows execution', async () => {
  const config = loadRuntimeConfig({ CONNECTOR_RUNTIME_ENABLED: '1', CONNECTOR_RUNTIME_CHAT: '1', CONNECTOR_RUNTIME_CONNECTORS: 'gmail' });
  const { runtime } = buildRuntime({ gmail_search: SEARCH_PAYLOAD }, { config });
  const res = await runtime.executeTool('gmail__search', { query: 'x' }, CTX());
  assert.equal(res.status, 'completed');
});

test('makeResult always yields a well-formed result', () => {
  const r = makeResult({ status: 'nonsense', content: 'oops' });
  assert.equal(r.status, 'failed'); // invalid status coerced
  assert.deepEqual(r.content, []);  // non-array content coerced
  assert.equal(typeof r.metadata.durationMs, 'number');
});

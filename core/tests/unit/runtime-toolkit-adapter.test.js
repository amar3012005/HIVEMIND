// Connector Runtime V1 — Chat runtime-toolkit-adapter tests (fake toolkit).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { registerRuntimeConnectorGroups } from '../../src/agent/runtime-toolkit-adapter.js';
import { ConnectorRegistry } from '../../src/connectors/runtime/connector-registry.js';
import { ConnectorRuntime } from '../../src/connectors/runtime/connector-runtime.js';
import { GmailPlugin } from '../../src/connectors/runtime/plugins/gmail/index.js';
import { buildDefaultHooks } from '../../src/connectors/runtime/index.js';

function fakeToolkit() {
  const groups = new Map(); const tools = new Map(); const external = new Set();
  return {
    groups, tools, external,
    createToolGroup({ name, active }) { groups.set(name, { active: active === true, tools: new Set() }); },
    registerToolFunction(entry) { tools.set(entry.name, entry); },
    markGroupExternal(name) { external.add(name); },
  };
}

function runtimeWith(execImpl) {
  const reg = new ConnectorRegistry();
  reg.register(new GmailPlugin({ execGoogleTool: execImpl }));
  const rt = new ConnectorRuntime({ registry: reg, db: {}, hooks: buildDefaultHooks({}) });
  return rt;
}

test('registers gmail as an inactive external group with canonical tool names', () => {
  const rt = runtimeWith(async () => ({ count: 0, messages: [] }));
  const tk = fakeToolkit();
  const handled = registerRuntimeConnectorGroups({
    tk, runtime: rt, prisma: {}, userId: 'u1', orgId: 'o1', projectId: 'p1',
    selected: new Set(['gmail']), activeProviders: new Set(['gmail']),
  });
  assert.deepEqual(handled, ['gmail']);
  assert.equal(tk.groups.get('gmail').active, false, 'group inactive');
  assert.ok(tk.external.has('gmail'), 'group marked external (draft-approval applies)');
  assert.ok(tk.tools.has('gmail__search'), 'canonical read tool registered');
  assert.ok(tk.tools.has('gmail__send'), 'canonical write tool registered');
  assert.equal(tk.tools.get('gmail__search').readOnly, true);
  assert.equal(tk.tools.get('gmail__send').readOnly, false);
  assert.equal(tk.tools.get('gmail__send').external, true);
});

test('read handler calls runtime and unwraps the payload for the toolkit', async () => {
  const payload = { count: 1, messages: [{ id: 'm1' }] };
  const calls = [];
  const rt = runtimeWith(async (tool, args, scope) => { calls.push({ tool, scope }); return payload; });
  const tk = fakeToolkit();
  registerRuntimeConnectorGroups({ tk, runtime: rt, prisma: {}, userId: 'u1', orgId: 'o1', projectId: 'p1', selected: new Set(['gmail']), activeProviders: new Set(['gmail']) });
  const out = await tk.tools.get('gmail__search').handler({ query: 'x' }, {});
  assert.deepEqual(out, payload, 'handler returns raw payload for the toolkit to wrap');
  assert.equal(calls[0].tool, 'gmail_search'); // mapped to legacy inside plugin
  assert.deepEqual(calls[0].scope, { user_id: 'u1', org_id: 'o1' });
});

test('write handler does NOT double-gate (approvalOwnedBySurface) — executes directly', async () => {
  // prisma present → if the runtime DID gate, it would create a pending row.
  const rows = [];
  const prisma = { pendingWrite: { async findUnique() { return null; }, async create({ data }) { rows.push(data); return { id: 'pw', status: 'draft', ...data }; }, async updateMany() { return { count: 0 }; }, async update() { return {}; } } };
  const reg = new ConnectorRegistry();
  const calls = [];
  reg.register(new GmailPlugin({ execGoogleTool: async (t) => { calls.push(t); return { id: 'sent', sent: true }; } }));
  const rt = new ConnectorRuntime({ registry: reg, db: {}, hooks: buildDefaultHooks({ prisma }) });
  const tk = fakeToolkit();
  registerRuntimeConnectorGroups({ tk, runtime: rt, prisma, userId: 'u1', orgId: 'o1', projectId: 'p1', selected: new Set(['gmail']), activeProviders: new Set(['gmail']) });
  // the chat draft-approval middleware owns approval; the handler executes the approved write directly
  const out = await tk.tools.get('gmail__send').handler({ to: 'a@x.com', subject: 's', body: 'b' }, {});
  assert.equal(calls.length, 1, 'provider executed once (no runtime re-gate)');
  assert.equal(rows.length, 0, 'runtime did NOT create a pending_writes row (surface owns approval)');
  assert.equal(out.sent, true);
});

test('only runtime-known connectors handled; unknown fall through (empty handled)', () => {
  const rt = runtimeWith(async () => ({}));
  const tk = fakeToolkit();
  const handled = registerRuntimeConnectorGroups({ tk, runtime: rt, prisma: {}, userId: 'u1', orgId: 'o1', selected: new Set(['notion']), activeProviders: new Set(['notion']) });
  assert.deepEqual(handled, [], 'notion not in runtime → not handled → legacy path takes it');
  assert.equal(tk.tools.size, 0);
});

test('not-connected provider unwraps to a structured error (not a throw)', async () => {
  const rt = runtimeWith(async () => { throw new Error('gmail not connected for this user'); });
  const tk = fakeToolkit();
  registerRuntimeConnectorGroups({ tk, runtime: rt, prisma: {}, userId: 'u1', orgId: 'o1', selected: new Set(['gmail']), activeProviders: new Set(['gmail']) });
  const out = await tk.tools.get('gmail__search').handler({ query: 'x' }, {});
  assert.equal(out.status, 'not_connected');
  assert.ok(/not connected/i.test(out.error));
});
